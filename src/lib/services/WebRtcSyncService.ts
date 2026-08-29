import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import * as Y from 'yjs';
import {
    syncStore,
    pendingPairRequest,
    signalingStatus,
    pairedDevices,
    connectedPeers,
    type UserIdentity,
    type DevicePair,
    type SignalingStatus,
} from '../stores/sync';
import { currentDocument, appStore } from '../stores/app';
import { toDocumentSummary } from './documents';
import type { Document } from '../types';

interface RoomPeer {
    id: string;
    display_name: string;
}

interface RoomDoc {
    peer: RoomPeer;
    roomId: string;
    channel: RTCDataChannel | null;
}

// Wire-format shape for a document's metadata (id/title/type/timestamps), as
// opposed to its Yjs content. Exchanged so a peer can learn a document exists
// at all, independent of whether any CRDT content has been pulled for it yet.
export interface DocMeta {
    id: string;
    docType: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}

function toDocMeta(doc: Document): DocMeta {
    return {
        id: doc.id,
        docType: doc.doc_type,
        title: doc.title,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
    };
}

type DataChannelMessage =
    | { type: 'crdt-update'; docId: string; update: string }
    | { type: 'crdt-state-request'; docId: string }
    | { type: 'crdt-state-response'; docId: string; state: string }
    | { type: 'doc-list'; docs: DocMeta[] }
    | { type: 'doc-created'; doc: DocMeta }
    | { type: 'doc-renamed'; docId: string; title: string; updatedAt: number }
    | { type: 'doc-deleted'; docId: string };

// One negotiation session per paired peer, keyed by peer node_id. Implements the
// WHATWG "perfect negotiation" pattern so two peers that offer at the same time
// (both running a reconnect sweep, or both restarting ICE) converge on a single
// connection instead of clobbering each other's state.
interface PeerSession {
    peerNodeId: string;
    roomId: string;
    displayName: string;
    pc: RTCPeerConnection;
    // Impolite peer keeps its own offer on a collision; polite peer rolls back.
    polite: boolean;
    // Bumped on every teardown/rebuild; stamped onto outgoing description/ICE
    // payloads so the far side can drop messages from a superseded attempt.
    epoch: number;
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    dataChannel: RTCDataChannel | null;
    reconnectAttempts: number;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    promoteTimer?: ReturnType<typeof setTimeout>;
}

interface DescEnvelope {
    epoch: number;
    description: RTCSessionDescriptionInit;
    roomId?: string;
    displayName?: string;
}

interface IceEnvelope {
    epoch: number;
    candidate: RTCIceCandidateInit;
}

const roomDocs = new Map<string, RoomDoc>();
const sessions = new Map<string, PeerSession>();
// Peers the user explicitly disconnected this session - the auto-reconnect paths
// skip these until the app restarts or the user reconnects them manually.
const suppressReconnect = new Set<string>();
let identity: UserIdentity | null = null;
let cleanupFns: UnlistenFn[] = [];
let sweepRunning = false;

// `disconnected` often self-heals; wait this long before treating it as a drop.
const DISCONNECT_GRACE_MS = 5_000;
// Polite peer promotes itself to initiator if the impolite side never offers
// (e.g. it is still reconnecting to the broker).
const PROMOTE_TIMEOUT_MS = 6_000;
const RECONNECT_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

// Deterministic, needs no exchange: node_ids are unique. The lexicographically
// smaller node_id is the impolite peer and wins offer collisions.
function isPolite(peerNodeId: string): boolean {
    return !!identity && identity.node_id > peerNodeId;
}

function markPeerReconnecting(peerNodeId: string, reconnecting: boolean): void {
    syncStore.setPeerReconnecting(peerNodeId, reconnecting);
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Merges a raw Yjs update - either a live edit broadcast from a peer, or a full-state
// catch-up snapshot - into the locally persisted document, regardless of whether that
// document is currently open in the editor. Reuses save_yjs_update so it emits the same
// 'sync-received' event the editor already listens for, applying the change live if the
// doc happens to be open.
async function mergeRemoteDocUpdate(docId: string, updateBytes: Uint8Array): Promise<void> {
    try {
        const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', { docId });
        const ydoc = new Y.Doc();
        if (stateResult.state && stateResult.state.length > 0) {
            Y.applyUpdate(ydoc, new Uint8Array(stateResult.state));
        }
        Y.applyUpdate(ydoc, updateBytes);
        const merged = Y.encodeStateAsUpdate(ydoc);
        await invoke('save_yjs_update', {
            docId,
            update: Array.from(updateBytes),
            mergedState: Array.from(merged),
        });
        console.log(`[WebRtcSync] Merged remote update for doc ${docId} (${updateBytes.length} bytes)`);
    } catch (e) {
        console.error(`[WebRtcSync] Failed to merge remote update for doc ${docId}:`, e);
    }
}

async function respondToStateRequest(channel: RTCDataChannel, docId: string): Promise<void> {
    try {
        const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', { docId });
        if (channel.readyState !== 'open') return;
        const state = new Uint8Array(stateResult.state ?? []);
        const msg: DataChannelMessage = { type: 'crdt-state-response', docId, state: bytesToBase64(state) };
        channel.send(JSON.stringify(msg));
    } catch (e) {
        console.error(`[WebRtcSync] Failed to respond to state request for doc ${docId}:`, e);
    }
}

function requestStateOnChannel(channel: RTCDataChannel, docId: string): void {
    if (channel.readyState !== 'open') return;
    const msg: DataChannelMessage = { type: 'crdt-state-request', docId };
    channel.send(JSON.stringify(msg));
}

// Pushes a locally-made Yjs update to every connected peer's data channel. Called by the
// editor's save path right after it persists the update locally, so live edits propagate
// immediately to whichever devices are currently paired and connected.
export function broadcastDocUpdate(docId: string, update: Uint8Array): void {
    const msg: DataChannelMessage = { type: 'crdt-update', docId, update: bytesToBase64(update) };
    const payload = JSON.stringify(msg);
    for (const roomDoc of roomDocs.values()) {
        if (roomDoc.channel?.readyState === 'open') {
            roomDoc.channel.send(payload);
        }
    }
}

// Asks every connected peer for their full state of a document, e.g. when the editor opens
// a doc while already paired and connected (the onopen catch-up only covers the doc that
// was open at connection time).
export function requestDocSync(docId: string): void {
    for (const roomDoc of roomDocs.values()) {
        if (roomDoc.channel) {
            requestStateOnChannel(roomDoc.channel, docId);
        }
    }
}

// Learns about a document from a peer's doc-list/doc-created message: materializes a local
// row for it if we've never seen this docId before (ensure_document never clobbers an
// existing row), reflects it in the sidebar, then pulls its Yjs content if we don't already
// have an up-to-date copy. This is what lets a document created on one device become
// visible - not just content-synced - on the other.
async function reconcileRemoteDoc(channel: RTCDataChannel, meta: DocMeta): Promise<void> {
    let localDoc: Document | null = null;
    try {
        localDoc = await invoke<Document>('get_document', { docId: meta.id });
    } catch {
        localDoc = null;
    }

    if (!localDoc) {
        try {
            localDoc = await invoke<Document>('ensure_document', {
                docId: meta.id,
                docType: meta.docType,
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
            });
            appStore.addDocument(toDocumentSummary(localDoc));
            console.log(`[WebRtcSync] Learned about new document ${meta.id} ("${meta.title}") from peer`);
        } catch (e) {
            console.error(`[WebRtcSync] Failed to materialize remote document ${meta.id}:`, e);
            return;
        }
    }

    if (localDoc.updated_at < meta.updatedAt) {
        requestStateOnChannel(channel, meta.id);
    }
}

function handleDocList(channel: RTCDataChannel, docs: DocMeta[]): void {
    for (const meta of docs) {
        reconcileRemoteDoc(channel, meta).catch((e) =>
            console.error(`[WebRtcSync] Failed to reconcile doc ${meta.id} from doc-list:`, e)
        );
    }
}

async function handleDocRenamed(docId: string, title: string): Promise<void> {
    try {
        const doc = await invoke<Document>('update_document', { docId, title });
        const existing = get(appStore).documents.find((d) => d.id === docId);
        appStore.updateDocumentInList({ ...toDocumentSummary(doc), has_content: existing?.has_content ?? false });
        console.log(`[WebRtcSync] Applied remote rename for ${docId} -> "${title}"`);
    } catch (e) {
        console.error(`[WebRtcSync] Failed to apply remote rename for ${docId}:`, e);
    }
}

async function handleDocDeleted(docId: string): Promise<void> {
    try {
        await invoke('delete_document', { docId });
        appStore.removeDocument(docId);
        console.log(`[WebRtcSync] Applied remote delete for ${docId}`);
    } catch (e) {
        console.error(`[WebRtcSync] Failed to apply remote delete for ${docId}:`, e);
    }
}

// Broadcasts to every connected peer that a new document was created locally, so it shows
// up on their side immediately instead of waiting for the next reconnect's doc-list.
export function broadcastDocCreated(doc: Document): void {
    const msg: DataChannelMessage = { type: 'doc-created', doc: toDocMeta(doc) };
    const payload = JSON.stringify(msg);
    for (const roomDoc of roomDocs.values()) {
        if (roomDoc.channel?.readyState === 'open') {
            roomDoc.channel.send(payload);
        }
    }
}

// Ready for a future rename UI to call alongside invoke('update_document', ...) so the
// change reaches paired devices instead of staying local-only.
export function broadcastDocRenamed(docId: string, title: string, updatedAt: number): void {
    const msg: DataChannelMessage = { type: 'doc-renamed', docId, title, updatedAt };
    const payload = JSON.stringify(msg);
    for (const roomDoc of roomDocs.values()) {
        if (roomDoc.channel?.readyState === 'open') {
            roomDoc.channel.send(payload);
        }
    }
}

// Ready for a future delete UI to call alongside invoke('delete_document', ...) so the
// change reaches paired devices instead of staying local-only.
export function broadcastDocDeleted(docId: string): void {
    const msg: DataChannelMessage = { type: 'doc-deleted', docId };
    const payload = JSON.stringify(msg);
    for (const roomDoc of roomDocs.values()) {
        if (roomDoc.channel?.readyState === 'open') {
            roomDoc.channel.send(payload);
        }
    }
}

// Sends our full document manifest to a newly-opened data channel so the peer can learn
// about any document it's never seen, regardless of whether it has Yjs content yet.
async function sendDocList(channel: RTCDataChannel): Promise<void> {
    try {
        const entries = await invoke<Array<{ id: string; doc_type: string; title: string; created_at: number; updated_at: number }>>('list_document_metadata');
        const docs: DocMeta[] = entries.map((e) => ({
            id: e.id,
            docType: e.doc_type,
            title: e.title,
            createdAt: e.created_at,
            updatedAt: e.updated_at,
        }));
        if (channel.readyState !== 'open') return;
        const msg: DataChannelMessage = { type: 'doc-list', docs };
        channel.send(JSON.stringify(msg));
        console.log(`[WebRtcSync] Sent doc-list manifest (${docs.length} document(s))`);
    } catch (e) {
        console.error('[WebRtcSync] Failed to send doc-list manifest:', e);
    }
}

async function calculateRoomId(userA: string, userB: string): Promise<string> {
    const ids = [userA, userB].sort();
    const combined = ids.join(':');
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray.slice(0, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return hashHex;
}

async function refreshPairedDevices(): Promise<void> {
    const updated = await invoke<DevicePair[]>('list_paired_devices');
    syncStore.setPairedDevices(updated);
}

export async function initSync(): Promise<void> {
    console.log('[WebRtcSync] initSync() starting...');
    try {
        identity = await invoke<UserIdentity>('get_identity');
        console.log(`[WebRtcSync] Local identity: node_id=${identity.node_id} user_id=${identity.user_id} display_name=${identity.display_name}`);
        syncStore.setIdentity(identity);

        // Register listeners BEFORE connecting so the first mqtt-status / offer
        // events emitted during connect are not missed.
        await setupEventListeners();

        const mqttBroker = await invoke<string | null>('get_mqtt_broker_url');
        console.log(`[WebRtcSync] MQTT broker URL from config: ${mqttBroker || '(none)'}`);
        if (mqttBroker && mqttBroker.trim() !== '') {
            syncStore.setSignalingUrl(mqttBroker);
            syncStore.setSignalingStatus('connecting');
            try {
                console.log(`[WebRtcSync] Connecting to MQTT broker ${mqttBroker}...`);
                await invoke('mqtt_connect', { brokerUrl: mqttBroker });
                // Actual status is now driven by the mqtt-status event stream.
            } catch (e) {
                console.error('[WebRtcSync] Failed to connect to MQTT broker:', e);
                syncStore.setSignalingStatus('error');
            }
        } else {
            console.warn('[WebRtcSync] No MQTT broker URL configured, signaling will not start');
            syncStore.setSignalingStatus('disconnected');
        }

        await refreshPairedDevices();

        // If the broker connected fast enough that 'connected' already landed,
        // kick the reconnect sweep now; otherwise the mqtt-status listener will.
        if (get(signalingStatus) === 'connected') {
            void reconnectAllPairedDevices('init');
        }

        console.log('[WebRtcSync] initSync() complete, event listeners active');
    } catch (error) {
        console.error('[WebRtcSync] Failed to init sync:', error);
        syncStore.setSignalingStatus('error');
    }
}

// --- Perfect-negotiation transport helpers -----------------------------------

// The Rust signaling_manager forwards SignalingMessage.payload verbatim, so we can
// carry a JSON envelope (with an epoch tag) inside it without any Rust change.
// Falls back to the legacy bare-SDP / bare-candidate format from older peers.
function parseDescPayload(raw: string): { epoch: number; description: RTCSessionDescriptionInit } {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && o.description && typeof o.description === 'object') {
        return { epoch: typeof o.epoch === 'number' ? o.epoch : 0, description: o.description };
    }
    if (o && typeof o === 'object' && typeof o.type === 'string') {
        return { epoch: 0, description: o as RTCSessionDescriptionInit }; // legacy
    }
    throw new Error('unrecognised description payload');
}

function parseIcePayload(raw: string): { epoch: number; candidate: RTCIceCandidateInit } {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && o.candidate && typeof o.candidate === 'object') {
        return { epoch: typeof o.epoch === 'number' ? o.epoch : 0, candidate: o.candidate };
    }
    return { epoch: 0, candidate: o as RTCIceCandidateInit }; // legacy bare candidate
}

async function sendDescription(peerId: string, session: PeerSession, desc: RTCSessionDescription): Promise<void> {
    const payload = JSON.stringify({ epoch: session.epoch, description: desc.toJSON() });
    const cmd = desc.type === 'answer' ? 'mqtt_publish_answer' : 'mqtt_publish_offer';
    console.log(`[WebRtcSync] [${peerId}] -> ${desc.type} (epoch=${session.epoch})`);
    await invoke(cmd, { peerId, sdp: payload })
        .catch((e) => console.error(`[WebRtcSync] [${peerId}] Failed to publish ${desc.type}:`, e));
}

async function sendIceCandidate(peerId: string, session: PeerSession, candidate: RTCIceCandidate): Promise<void> {
    const payload = JSON.stringify({ epoch: session.epoch, candidate: candidate.toJSON() });
    await invoke('mqtt_publish_ice_candidate', { peerId, candidate: payload })
        .catch((e) => console.error(`[WebRtcSync] [${peerId}] Failed to publish ICE candidate:`, e));
}

// --- Session lifecycle ------------------------------------------------------

function clearSessionTimers(session: PeerSession): void {
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = undefined; }
    if (session.promoteTimer) { clearTimeout(session.promoteTimer); session.promoteTimer = undefined; }
}

function teardownSession(peerNodeId: string, opts: { keepAttempts?: boolean } = {}): void {
    const session = sessions.get(peerNodeId);
    if (!session) return;
    console.log(`[WebRtcSync] teardownSession(${peerNodeId}) keepAttempts=${!!opts.keepAttempts}`);
    clearSessionTimers(session);
    try { session.dataChannel?.close(); } catch { /* noop */ }
    try {
        session.pc.onnegotiationneeded = null;
        session.pc.onicecandidate = null;
        session.pc.oniceconnectionstatechange = null;
        session.pc.onconnectionstatechange = null;
        session.pc.ondatachannel = null;
        session.pc.close();
    } catch { /* noop */ }
    sessions.delete(peerNodeId);
    roomDocs.delete(session.roomId);
    if (!opts.keepAttempts) {
        markPeerReconnecting(peerNodeId, false);
    }
}

interface EnsureOpts {
    // Create the data channel (and thus be the one to fire the first offer).
    initiate: boolean;
    // Rebuild even if a live-looking session already exists.
    force?: boolean;
}

// Single symmetric entry point for both a fresh pairing and a reconnect. Sets up
// one RTCPeerConnection per peer and drives negotiation via onnegotiationneeded,
// so simultaneous offers are resolved by the perfect-negotiation logic in
// handleDescription rather than corrupting shared state.
async function ensurePeerConnection(
    peerNodeId: string,
    roomId: string,
    displayName: string,
    opts: EnsureOpts,
): Promise<PeerSession | null> {
    if (!identity) {
        console.warn('[WebRtcSync] ensurePeerConnection() before identity loaded, aborting');
        return null;
    }

    const existing = sessions.get(peerNodeId);
    if (existing) {
        const st = existing.pc.connectionState;
        if (!opts.force && (st === 'new' || st === 'connecting' || st === 'connected')) {
            return existing;
        }
        teardownSession(peerNodeId, { keepAttempts: true });
    }

    const polite = isPolite(peerNodeId);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const session: PeerSession = {
        peerNodeId,
        roomId,
        displayName,
        pc,
        polite,
        epoch: (existing?.epoch ?? 0) + 1,
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        dataChannel: null,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
    };
    sessions.set(peerNodeId, session);
    roomDocs.set(roomId, { peer: { id: peerNodeId, display_name: displayName }, roomId, channel: null });
    markPeerReconnecting(peerNodeId, true);

    console.log(`[WebRtcSync] ensurePeerConnection() -> ${displayName} (peer=${peerNodeId}, room=${roomId}, polite=${polite}, initiate=${opts.initiate}, epoch=${session.epoch})`);

    pc.onnegotiationneeded = async () => {
        try {
            session.makingOffer = true;
            await pc.setLocalDescription();
            if (pc.localDescription) await sendDescription(peerNodeId, session, pc.localDescription);
        } catch (e) {
            console.error(`[WebRtcSync] [${peerNodeId}] negotiationneeded failed:`, e);
        } finally {
            session.makingOffer = false;
        }
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) void sendIceCandidate(peerNodeId, session, candidate);
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRtcSync] [${peerNodeId}] iceConnectionState -> ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            try { pc.restartIce(); } catch (e) { console.warn(`[WebRtcSync] [${peerNodeId}] restartIce() failed:`, e); }
        }
    };

    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        console.log(`[WebRtcSync] [${peerNodeId}] connectionState -> ${st} (room=${roomId})`);
        if (st === 'connected') {
            session.reconnectAttempts = 0;
            clearSessionTimers(session);
            markPeerReconnecting(peerNodeId, false);
            syncStore.addConnectedPeer({ peer_node_id: peerNodeId, peer_display_name: displayName, room_id: roomId });
            invoke('save_pair', { peerNodeId, peerDisplayName: displayName, roomId })
                .then(refreshPairedDevices)
                .catch((e) => console.error(`[WebRtcSync] [${peerNodeId}] Failed to save pair:`, e));
        } else if (st === 'failed') {
            syncStore.removeConnectedPeer(roomId);
            scheduleReconnect(peerNodeId);
        } else if (st === 'disconnected') {
            syncStore.removeConnectedPeer(roomId);
            if (!session.graceTimer) {
                session.graceTimer = setTimeout(() => {
                    session.graceTimer = undefined;
                    if (pc.connectionState === 'disconnected') scheduleReconnect(peerNodeId);
                }, DISCONNECT_GRACE_MS);
            }
        } else if (st === 'closed') {
            syncStore.removeConnectedPeer(roomId);
        }
    };

    pc.ondatachannel = ({ channel }) => {
        console.log(`[WebRtcSync] [${peerNodeId}] Remote data channel '${channel.label}' (room=${roomId})`);
        session.dataChannel = channel;
        const rd = roomDocs.get(roomId);
        if (rd) rd.channel = channel;
        setupDataChannel(channel, roomId);
    };

    if (opts.initiate) {
        const channel = pc.createDataChannel('yjs-sync', { ordered: true }); // fires onnegotiationneeded
        session.dataChannel = channel;
        const rd = roomDocs.get(roomId);
        if (rd) rd.channel = channel;
        setupDataChannel(channel, roomId);
    } else if (polite) {
        // If the impolite side never offers (still reconnecting to the broker,
        // say), promote ourselves to initiator after a grace period.
        session.promoteTimer = setTimeout(() => {
            session.promoteTimer = undefined;
            if (sessions.get(peerNodeId) === session
                && pc.connectionState !== 'connected'
                && !session.dataChannel) {
                console.log(`[WebRtcSync] [${peerNodeId}] promotion timeout - initiating`);
                void ensurePeerConnection(peerNodeId, roomId, displayName, { initiate: true, force: true });
            }
        }, PROMOTE_TIMEOUT_MS);
    }

    return session;
}

// Perfect-negotiation handler for BOTH offers and answers.
async function handleDescription(from: string, env: DescEnvelope): Promise<void> {
    let session = sessions.get(from);

    if (!session) {
        if (env.description.type !== 'offer') {
            console.warn(`[WebRtcSync] [${from}] stray ${env.description.type} with no session, dropping`);
            return;
        }
        if (!env.roomId) {
            console.warn(`[WebRtcSync] [${from}] offer without room_id, dropping`);
            return;
        }
        const built = await ensurePeerConnection(from, env.roomId, env.displayName || from, { initiate: false });
        if (!built) return;
        session = built;
    }

    // Drop descriptions from a superseded negotiation attempt (epoch 0 == legacy peer,
    // always processed).
    if (env.epoch > 0 && env.epoch < session.epoch) {
        console.log(`[WebRtcSync] [${from}] ignoring stale description (epoch ${env.epoch} < ${session.epoch})`);
        return;
    }

    const { pc } = session;
    const description = env.description;
    const readyForOffer =
        !session.makingOffer &&
        (pc.signalingState === 'stable' || session.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    session.ignoreOffer = !session.polite && offerCollision;
    if (session.ignoreOffer) {
        console.warn(`[WebRtcSync] [${from}] impolite peer - ignoring colliding offer`);
        return;
    }

    try {
        session.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description); // polite peer rolls back implicitly on collision
        session.isSettingRemoteAnswerPending = false;
        if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription) await sendDescription(from, session, pc.localDescription);
        }
    } catch (e) {
        session.isSettingRemoteAnswerPending = false;
        console.error(`[WebRtcSync] [${from}] handleDescription failed:`, e);
    }
}

async function handleIceCandidate(from: string, env: IceEnvelope): Promise<void> {
    const session = sessions.get(from);
    if (!session) {
        console.warn(`[WebRtcSync] [${from}] ICE candidate with no session, dropping`);
        return;
    }
    if (env.epoch > 0 && env.epoch < session.epoch) return;
    try {
        await session.pc.addIceCandidate(new RTCIceCandidate(env.candidate));
    } catch (e) {
        if (!session.ignoreOffer) console.error(`[WebRtcSync] [${from}] Failed to add ICE candidate:`, e);
    }
}

// --- Reconnect scheduling --------------------------------------------------

function scheduleReconnect(peerNodeId: string): void {
    const session = sessions.get(peerNodeId);
    if (!session || session.reconnectTimer) return;
    if (suppressReconnect.has(peerNodeId)) return;
    // While the broker is unreachable, wait for the mqtt-connected sweep instead.
    if (get(signalingStatus) !== 'connected') return;

    const pair = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
    if (!pair) { teardownSession(peerNodeId); return; }

    const attempt = session.reconnectAttempts;
    session.reconnectAttempts = attempt + 1;
    const delay = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_MS) + jitter(0, 1000);
    console.log(`[WebRtcSync] [${peerNodeId}] reconnect attempt ${attempt + 1} in ${Math.round(delay)}ms`);
    markPeerReconnecting(peerNodeId, true);

    session.reconnectTimer = setTimeout(() => {
        session.reconnectTimer = undefined;
        const current = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
        if (!current) { teardownSession(peerNodeId); return; }
        if (suppressReconnect.has(peerNodeId) || get(signalingStatus) !== 'connected') return;
        void ensurePeerConnection(current.peer_node_id, current.room_id, current.peer_display_name, {
            initiate: !isPolite(peerNodeId),
            force: true,
        });
    }, delay);
}

function pauseAllReconnects(): void {
    for (const session of sessions.values()) {
        clearSessionTimers(session);
        session.reconnectAttempts = 0;
    }
}

// Re-establish connections to every paired device that isn't already connected.
// Triggered on startup and whenever MQTT signaling (re)connects.
export async function reconnectAllPairedDevices(reason: string): Promise<void> {
    if (!identity || sweepRunning) return;
    if (get(signalingStatus) !== 'connected') return;
    sweepRunning = true;
    console.log(`[WebRtcSync] reconnectAllPairedDevices(${reason})`);
    try {
        await refreshPairedDevices();
        const connectedRooms = new Set(get(connectedPeers).map((p) => p.room_id));
        for (const pair of get(pairedDevices)) {
            if (connectedRooms.has(pair.room_id)) continue;
            if (suppressReconnect.has(pair.peer_node_id)) continue;
            const s = sessions.get(pair.peer_node_id);
            if (s && (s.pc.connectionState === 'connecting' || s.pc.connectionState === 'connected')) continue;
            await sleep(jitter(150, 450)); // stagger negotiations
            void ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
                initiate: !isPolite(pair.peer_node_id),
            });
        }
    } finally {
        sweepRunning = false;
    }
}

// Called once a pair-response with accepted=true arrives - we now have the peer's real
// user_id, so room_id can be derived correctly on both sides (see the mismatch bug fix
// in the pairing plan: room_id must come from two real user_ids, never a node_id).
export async function initiateOffer(peerNodeId: string, peerUserId: string, peerDisplayName: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] initiateOffer() called before identity was loaded, aborting');
        return;
    }
    const roomId = await calculateRoomId(identity.user_id, peerUserId);
    suppressReconnect.delete(peerNodeId);
    await ensurePeerConnection(peerNodeId, roomId, peerDisplayName, { initiate: true, force: true });
}

// Step 1 of the pairing handshake: tell a specific node_id (typed or QR-scanned into the
// same input field, never picked from an open discovery list) that we'd like to pair.
export async function sendPairRequest(peerNodeId: string): Promise<void> {
    if (!identity) {
        console.warn('[WebRtcSync] sendPairRequest() called before identity was loaded, aborting');
        return;
    }
    syncStore.setPairingState('requesting');
    try {
        console.log(`[WebRtcSync] sendPairRequest() -> ${peerNodeId}`);
        await invoke('mqtt_publish_pair_request', { peerNodeId });
    } catch (e) {
        console.error('[WebRtcSync] Failed to send pair request:', e);
        syncStore.setPairingState(null);
    }
}

// Step 2, on the receiving side: the user explicitly accepts or declines the incoming
// pair-request shown in PairingDialog. Accepting authorizes the peer's node_id on the
// Rust side (signaling_manager::authorize_peer) before the pair-response goes out, so the
// offer that follows is trusted rather than dropped as unsolicited.
export async function respondToPairRequest(accept: boolean): Promise<void> {
    const req = get(pendingPairRequest);
    if (!req) {
        console.warn('[WebRtcSync] respondToPairRequest() called with no pending request');
        return;
    }
    syncStore.setPendingPairRequest(null);
    try {
        if (accept) {
            console.log(`[WebRtcSync] Accepting pair request from ${req.from}`);
            await invoke('mqtt_accept_pair_request', {
                peerNodeId: req.from,
                peerUserId: req.user_id,
                peerDisplayName: req.display_name,
            });
        } else {
            console.log(`[WebRtcSync] Declining pair request from ${req.from}`);
            await invoke('mqtt_decline_pair_request', { peerNodeId: req.from });
        }
    } catch (e) {
        console.error('[WebRtcSync] Failed to respond to pair request:', e);
    }
}

function setupDataChannel(channel: RTCDataChannel, roomId: string): void {
    const roomDoc = roomDocs.get(roomId);
    if (!roomDoc) {
        console.warn(`[WebRtcSync] setupDataChannel() called for room ${roomId} but no roomDoc exists yet`);
        return;
    }

    const { peer } = roomDoc;
    roomDoc.channel = channel;
    console.log(`[WebRtcSync] Setting up data channel '${channel.label}' for room ${roomId} (peer=${peer.id}, initial readyState=${channel.readyState})`);

    channel.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data as string) as DataChannelMessage;
            console.log(`[WebRtcSync] [room=${roomId}] Received '${msg.type}'`);
            switch (msg.type) {
                case 'crdt-update':
                    mergeRemoteDocUpdate(msg.docId, base64ToBytes(msg.update));
                    break;
                case 'crdt-state-request':
                    respondToStateRequest(channel, msg.docId);
                    break;
                case 'crdt-state-response':
                    mergeRemoteDocUpdate(msg.docId, base64ToBytes(msg.state));
                    break;
                case 'doc-list':
                    handleDocList(channel, msg.docs);
                    break;
                case 'doc-created':
                    reconcileRemoteDoc(channel, msg.doc).catch((e) =>
                        console.error(`[WebRtcSync] Failed to reconcile doc ${msg.doc.id} from doc-created:`, e)
                    );
                    break;
                case 'doc-renamed':
                    handleDocRenamed(msg.docId, msg.title);
                    break;
                case 'doc-deleted':
                    handleDocDeleted(msg.docId);
                    break;
            }
        } catch (e) {
            console.error(`[WebRtcSync] [room=${roomId}] Failed to handle data channel message:`, e);
        }
    };

    channel.onopen = () => {
        console.log(`[WebRtcSync] DataChannel open for room ${roomId} (peer=${peer.id})`);
        markPeerReconnecting(peer.id, false);
        syncStore.addConnectedPeer({
            peer_node_id: peer.id,
            peer_display_name: peer.display_name,
            room_id: roomId,
        });
        sendDocList(channel);
        const openDoc = get(currentDocument);
        if (openDoc?.id) {
            console.log(`[WebRtcSync] Requesting catch-up sync for currently open doc ${openDoc.id} from peer ${peer.id}`);
            requestStateOnChannel(channel, openDoc.id);
        }
    };

    channel.onclose = () => {
        console.log(`[WebRtcSync] DataChannel closed for room ${roomId} (peer=${peer.id})`);
        syncStore.removeConnectedPeer(roomId);
        const session = sessions.get(peer.id);
        if (session && session.pc.connectionState !== 'closed') {
            scheduleReconnect(peer.id);
        }
    };

    channel.onerror = (event) => {
        console.error(`[WebRtcSync] DataChannel error for room ${roomId} (peer=${peer.id}):`, event);
    };
}

function sessionByRoom(roomId: string): PeerSession | undefined {
    for (const session of sessions.values()) {
        if (session.roomId === roomId) return session;
    }
    return undefined;
}

// User-initiated disconnect: tear down and stay down until the app restarts or
// the user reconnects manually.
export function disconnectPeer(roomId: string): void {
    const session = sessionByRoom(roomId);
    if (session) {
        suppressReconnect.add(session.peerNodeId);
        teardownSession(session.peerNodeId);
    } else {
        roomDocs.delete(roomId);
    }
    syncStore.removeConnectedPeer(roomId);
}

export function disconnectAll(): void {
    for (const peerNodeId of [...sessions.keys()]) {
        teardownSession(peerNodeId);
    }
    roomDocs.clear();
    syncStore.setConnectedPeers([]);
}

async function setupEventListeners(): Promise<void> {
    console.log('[WebRtcSync] Registering Tauri event listeners (mqtt-pair-request-received, mqtt-pair-response-received, mqtt-offer-received, mqtt-answer-received, mqtt-ice-candidate-received, mqtt-status)');

    const unlistenPairRequest = await listen<{ from: string; user_id: string; display_name: string }>('mqtt-pair-request-received', (event) => {
        console.log(`[WebRtcSync] event: mqtt-pair-request-received from=${event.payload.from} display_name=${event.payload.display_name}`);
        syncStore.setPendingPairRequest(event.payload);
    });

    const unlistenPairResponse = await listen<{ from: string; user_id: string; display_name: string; accepted: boolean }>('mqtt-pair-response-received', async (event) => {
        const { from, user_id, display_name, accepted } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-pair-response-received from=${from} accepted=${accepted}`);
        if (accepted) {
            syncStore.setPairingState(null);
            await initiateOffer(from, user_id, display_name);
        } else {
            syncStore.setPairingState('declined');
        }
    });

    const unlistenOffer = await listen<{ from: string; sdp: string; room_id: string; display_name: string }>('mqtt-offer-received', async (event) => {
        const { from, sdp, room_id, display_name } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-offer-received from=${from} room_id=${room_id}`);
        try {
            const { epoch, description } = parseDescPayload(sdp);
            await handleDescription(from, { epoch, description, roomId: room_id, displayName: display_name });
        } catch (e) {
            console.error(`[WebRtcSync] [${from}] bad offer payload:`, e);
        }
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string }>('mqtt-answer-received', async (event) => {
        const { from, sdp } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-answer-received from=${from}`);
        try {
            const { epoch, description } = parseDescPayload(sdp);
            await handleDescription(from, { epoch, description });
        } catch (e) {
            console.error(`[WebRtcSync] [${from}] bad answer payload:`, e);
        }
    });

    const unlistenIce = await listen<{ from: string; candidate: string }>('mqtt-ice-candidate-received', async (event) => {
        const { from, candidate } = event.payload;
        console.log(`[WebRtcSync] event: mqtt-ice-candidate-received from=${from}`);
        try {
            const { epoch, candidate: cand } = parseIcePayload(candidate);
            await handleIceCandidate(from, { epoch, candidate: cand });
        } catch (e) {
            console.error(`[WebRtcSync] [${from}] bad ICE payload:`, e);
        }
    });

    const unlistenStatus = await listen<string>('mqtt-status', (event) => {
        const next = event.payload as SignalingStatus;
        const prev = get(signalingStatus);
        console.log(`[WebRtcSync] event: mqtt-status -> ${next} (was ${prev})`);
        syncStore.setSignalingStatus(next);
        if (next === 'connected' && prev !== 'connected') {
            void reconnectAllPairedDevices('mqtt-connected');
        } else if (next === 'disconnected' || next === 'error') {
            pauseAllReconnects();
        }
    });

    cleanupFns = [unlistenPairRequest, unlistenPairResponse, unlistenOffer, unlistenAnswer, unlistenIce, unlistenStatus];
    console.log('[WebRtcSync] Event listeners registered');
}

export function getCleanup(): () => void {
    return () => {
        console.warn(`[WebRtcSync] getCleanup() invoked - tearing down ${cleanupFns.length} Tauri event listener(s) and disconnecting all rooms. Signaling messages arriving after this point will be MISSED until initSync() runs again.`);
        cleanupFns.forEach(fn => fn());
        cleanupFns = [];
        disconnectAll();
        suppressReconnect.clear();
    };
}
