import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
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
import { DocumentRepository } from './DocumentRepository';
import { attachFraming, type FramedChannel } from './channel/Framing';
import { DocSyncProtocol, type SyncProgressSink } from './channel/DocSyncProtocol';
import { isSyncMessage, type SyncMessage } from './protocol';

// One negotiation session per paired peer, keyed by peer node_id. Implements the
// WHATWG "perfect negotiation" pattern so two peers that offer at the same time
// (both running a reconnect sweep, or both restarting ICE) converge on a single
// connection instead of clobbering each other's state. See ADR 0002.
//
// The data channel that results carries the document-sync protocol
// (channel/DocSyncProtocol.ts) through a chunked framing layer; this module owns
// the connection lifecycle, not the sync content. See ADR 0003.
interface PeerSession {
    peerNodeId: string;
    roomId: string;
    displayName: string;
    pc: RTCPeerConnection;
    polite: boolean;
    epoch: number;
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    dataChannel: RTCDataChannel | null;
    framed: FramedChannel | null;
    proto: DocSyncProtocol | null;
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

const repo = new DocumentRepository();
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

// --- exported repository handle (editor save path) --------------------------

export const documentRepository = repo;

// --- live steady-state broadcasts -----------------------------------------

function openProtos(): Array<{ session: PeerSession; proto: DocSyncProtocol }> {
    const out: Array<{ session: PeerSession; proto: DocSyncProtocol }> = [];
    for (const session of sessions.values()) {
        if (session.proto && session.dataChannel?.readyState === 'open') {
            out.push({ session, proto: session.proto });
        }
    }
    return out;
}

function broadcast(msg: SyncMessage): void {
    for (const { session } of openProtos()) {
        void session.framed?.send(msg);
    }
}

// Called by the editor save path right after it persists an update locally.
export function broadcastLocalUpdate(docId: string, update: string): void {
    broadcast({ t: 'live-update', id: docId, update });
}

export function broadcastDocCreated(entry: {
    id: string;
    docType: string;
    title: string;
    titleUpdatedAt: number;
    createdAt: number;
}): void {
    broadcast({
        t: 'doc-created',
        entry: {
            id: entry.id,
            docType: entry.docType,
            title: entry.title,
            titleUpdatedAt: entry.titleUpdatedAt,
            createdAt: entry.createdAt,
            isDeleted: false,
            deletedAt: null,
            contentHash: null,
        },
    });
}

export function broadcastDocRenamed(docId: string, title: string, titleUpdatedAt: number): void {
    broadcast({ t: 'doc-renamed', id: docId, title, titleUpdatedAt });
}

export function broadcastDocDeleted(docId: string, deletedAt: number): void {
    broadcast({ t: 'doc-deleted', id: docId, deletedAt });
}

// --- transport helpers ---------------------------------------------------

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
    console.log(`[sync] [${peerId}] -> ${desc.type} (epoch=${session.epoch})`);
    await invoke(cmd, { peerId, sdp: payload }).catch((e) =>
        console.error(`[sync] [${peerId}] Failed to publish ${desc.type}:`, e),
    );
}

async function sendIceCandidate(peerId: string, session: PeerSession, candidate: RTCIceCandidate): Promise<void> {
    const payload = JSON.stringify({ epoch: session.epoch, candidate: candidate.toJSON() });
    await invoke('mqtt_publish_ice_candidate', { peerId, candidate: payload }).catch((e) =>
        console.error(`[sync] [${peerId}] Failed to publish ICE candidate:`, e),
    );
}

async function calculateRoomId(userA: string, userB: string): Promise<string> {
    const ids = [userA, userB].sort();
    const data = new TextEncoder().encode(ids.join(':'));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer).slice(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

async function refreshPairedDevices(): Promise<void> {
    const updated = await invoke<DevicePair[]>('list_paired_devices');
    syncStore.setPairedDevices(updated);
}

// --- session lifecycle -------------------------------------------------

function clearSessionTimers(session: PeerSession): void {
    if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = undefined; }
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = undefined; }
    if (session.promoteTimer) { clearTimeout(session.promoteTimer); session.promoteTimer = undefined; }
}

function disposeChannel(session: PeerSession): void {
    session.proto?.dispose();
    session.framed?.detach();
    session.proto = null;
    session.framed = null;
}

function teardownSession(peerNodeId: string, opts: { keepAttempts?: boolean } = {}): void {
    const session = sessions.get(peerNodeId);
    if (!session) return;
    console.log(`[sync] teardownSession(${peerNodeId}) keepAttempts=${!!opts.keepAttempts}`);
    clearSessionTimers(session);
    disposeChannel(session);
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
    syncStore.clearRoomSync(session.roomId);
    if (!opts.keepAttempts) {
        markPeerReconnecting(peerNodeId, false);
    }
}

interface EnsureOpts {
    initiate: boolean;
    force?: boolean;
}

async function ensurePeerConnection(
    peerNodeId: string,
    roomId: string,
    displayName: string,
    opts: EnsureOpts,
): Promise<PeerSession | null> {
    if (!identity) {
        console.warn('[sync] ensurePeerConnection() before identity loaded, aborting');
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
        framed: null,
        proto: null,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
    };
    sessions.set(peerNodeId, session);
    syncStore.setRoomSyncPhase(roomId, 'connecting');
    markPeerReconnecting(peerNodeId, true);

    console.log(`[sync] ensurePeerConnection() -> ${displayName} (peer=${peerNodeId}, room=${roomId}, polite=${polite}, initiate=${opts.initiate}, epoch=${session.epoch})`);

    pc.onnegotiationneeded = async () => {
        try {
            session.makingOffer = true;
            await pc.setLocalDescription();
            if (pc.localDescription) await sendDescription(peerNodeId, session, pc.localDescription);
        } catch (e) {
            console.error(`[sync] [${peerNodeId}] negotiationneeded failed:`, e);
        } finally {
            session.makingOffer = false;
        }
    };

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) void sendIceCandidate(peerNodeId, session, candidate);
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[sync] [${peerNodeId}] iceConnectionState -> ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            try { pc.restartIce(); } catch (e) { console.warn(`[sync] [${peerNodeId}] restartIce() failed:`, e); }
        }
    };

    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        console.log(`[sync] [${peerNodeId}] connectionState -> ${st} (room=${roomId})`);
        if (st === 'connected') {
            session.reconnectAttempts = 0;
            clearSessionTimers(session);
            markPeerReconnecting(peerNodeId, false);
            syncStore.addConnectedPeer({ peer_node_id: peerNodeId, peer_display_name: displayName, room_id: roomId });
            invoke('save_pair', { peerNodeId, peerDisplayName: displayName, roomId })
                .then(refreshPairedDevices)
                .catch((e) => console.error(`[sync] [${peerNodeId}] Failed to save pair:`, e));
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
        console.log(`[sync] [${peerNodeId}] Remote data channel '${channel.label}' (room=${roomId})`);
        wireDataChannel(channel, session);
    };

    if (opts.initiate) {
        const channel = pc.createDataChannel('yjs-sync', { ordered: true }); // fires onnegotiationneeded
        wireDataChannel(channel, session);
    } else if (polite) {
        session.promoteTimer = setTimeout(() => {
            session.promoteTimer = undefined;
            if (sessions.get(peerNodeId) === session
                && pc.connectionState !== 'connected'
                && !session.dataChannel) {
                console.log(`[sync] [${peerNodeId}] promotion timeout - initiating`);
                void ensurePeerConnection(peerNodeId, roomId, displayName, { initiate: true, force: true });
            }
        }, PROMOTE_TIMEOUT_MS);
    }

    return session;
}

// --- data-channel wiring: framing + document-sync protocol -------------

function wireDataChannel(channel: RTCDataChannel, session: PeerSession): void {
    session.dataChannel = channel;

    const sink: SyncProgressSink = {
        onPhase: (phase) => syncStore.setRoomSyncPhase(session.roomId, phase),
        onProgress: (pending, total) => syncStore.setRoomSyncProgress(session.roomId, pending, total),
        onSynced: (at) => {
            syncStore.markRoomSynced(session.roomId, at);
            invoke('update_pair_sync_time', { roomId: session.roomId })
                .then(refreshPairedDevices)
                .catch((e) => console.error(`[sync] [${session.peerNodeId}] update_pair_sync_time failed:`, e));
        },
    };

    const proto = new DocSyncProtocol(repo, (m) => session.framed?.send(m), sink);
    const framed = attachFraming(channel, (m) => {
        if (isSyncMessage(m)) {
            void proto.handle(m).catch((e) =>
                console.error(`[sync] [room=${session.roomId}] handle('${m.t}') failed:`, e),
            );
        }
    });
    session.proto = proto;
    session.framed = framed;

    channel.onopen = () => {
        console.log(`[sync] DataChannel open for room ${session.roomId} (peer=${session.peerNodeId})`);
        markPeerReconnecting(session.peerNodeId, false);
        syncStore.addConnectedPeer({
            peer_node_id: session.peerNodeId,
            peer_display_name: session.displayName,
            room_id: session.roomId,
        });
        void proto.start();
    };

    channel.onclose = () => {
        console.log(`[sync] DataChannel closed for room ${session.roomId} (peer=${session.peerNodeId})`);
        disposeChannel(session);
        syncStore.removeConnectedPeer(session.roomId);
        syncStore.setRoomSyncPhase(session.roomId, 'idle');
        if (session.pc.connectionState !== 'closed') {
            scheduleReconnect(session.peerNodeId);
        }
    };

    channel.onerror = (event) => {
        console.error(`[sync] DataChannel error for room ${session.roomId} (peer=${session.peerNodeId}):`, event);
    };
}

// --- perfect-negotiation description / ICE handlers -------------------

async function handleDescription(from: string, env: DescEnvelope): Promise<void> {
    let session = sessions.get(from);

    if (!session) {
        if (env.description.type !== 'offer') {
            console.warn(`[sync] [${from}] stray ${env.description.type} with no session, dropping`);
            return;
        }
        if (!env.roomId) {
            console.warn(`[sync] [${from}] offer without room_id, dropping`);
            return;
        }
        const built = await ensurePeerConnection(from, env.roomId, env.displayName || from, { initiate: false });
        if (!built) return;
        session = built;
    }

    if (env.epoch > 0 && env.epoch < session.epoch) {
        console.log(`[sync] [${from}] ignoring stale description (epoch ${env.epoch} < ${session.epoch})`);
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
        console.warn(`[sync] [${from}] impolite peer - ignoring colliding offer`);
        return;
    }

    try {
        session.isSettingRemoteAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        session.isSettingRemoteAnswerPending = false;
        if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription) await sendDescription(from, session, pc.localDescription);
        }
    } catch (e) {
        session.isSettingRemoteAnswerPending = false;
        console.error(`[sync] [${from}] handleDescription failed:`, e);
    }
}

async function handleIceCandidate(from: string, env: IceEnvelope): Promise<void> {
    const session = sessions.get(from);
    if (!session) {
        console.warn(`[sync] [${from}] ICE candidate with no session, dropping`);
        return;
    }
    if (env.epoch > 0 && env.epoch < session.epoch) return;
    try {
        await session.pc.addIceCandidate(new RTCIceCandidate(env.candidate));
    } catch (e) {
        if (!session.ignoreOffer) console.error(`[sync] [${from}] Failed to add ICE candidate:`, e);
    }
}

// --- reconnect scheduling -------------------------------------------

function scheduleReconnect(peerNodeId: string): void {
    const session = sessions.get(peerNodeId);
    if (!session || session.reconnectTimer) return;
    if (suppressReconnect.has(peerNodeId)) return;
    if (get(signalingStatus) !== 'connected') return;

    const pair = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
    if (!pair) { teardownSession(peerNodeId); return; }

    const attempt = session.reconnectAttempts;
    session.reconnectAttempts = attempt + 1;
    const delay = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_MS) + jitter(0, 1000);
    console.log(`[sync] [${peerNodeId}] reconnect attempt ${attempt + 1} in ${Math.round(delay)}ms`);
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

// User-triggered "Reconnect now" for a single peer. Cancels any pending backoff
// wait, resets the attempt counter, lifts an explicit-disconnect suppression, and
// starts a fresh connection immediately. No-op if the peer is already connected.
export async function reconnectPeer(peerNodeId: string): Promise<void> {
    if (!identity) {
        console.warn('[sync] reconnectPeer() called before identity was loaded, aborting');
        return;
    }
    if (get(signalingStatus) !== 'connected') {
        console.warn(`[sync] reconnectPeer(${peerNodeId}) ignored - signaling not connected`);
        return;
    }
    const pair = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
    if (!pair) {
        console.warn(`[sync] reconnectPeer(${peerNodeId}) - no matching pair, ignoring`);
        return;
    }

    suppressReconnect.delete(peerNodeId);

    const existing = sessions.get(peerNodeId);
    if (existing) {
        if (existing.pc.connectionState === 'connected' && existing.dataChannel?.readyState === 'open') {
            console.log(`[sync] reconnectPeer(${peerNodeId}) - already connected, ignoring`);
            return;
        }
        clearSessionTimers(existing);
        existing.reconnectAttempts = 0;
    }

    console.log(`[sync] reconnectPeer(${peerNodeId}) - forcing immediate reconnect`);
    markPeerReconnecting(peerNodeId, true);
    await ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
        initiate: !isPolite(peerNodeId),
        force: true,
    });
}

export async function reconnectAllPairedDevices(reason: string): Promise<void> {
    if (!identity || sweepRunning) return;
    if (get(signalingStatus) !== 'connected') return;
    sweepRunning = true;
    console.log(`[sync] reconnectAllPairedDevices(${reason})`);
    try {
        await refreshPairedDevices();
        const connectedRooms = new Set(get(connectedPeers).map((p) => p.room_id));
        for (const pair of get(pairedDevices)) {
            if (connectedRooms.has(pair.room_id)) continue;
            if (suppressReconnect.has(pair.peer_node_id)) continue;
            const s = sessions.get(pair.peer_node_id);
            if (s && (s.pc.connectionState === 'connecting' || s.pc.connectionState === 'connected')) continue;
            await sleep(jitter(150, 450));
            void ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
                initiate: !isPolite(pair.peer_node_id),
            });
        }
    } finally {
        sweepRunning = false;
    }
}

// --- pairing ---------------------------------------------------------

export async function initiateOffer(peerNodeId: string, peerUserId: string, peerDisplayName: string): Promise<void> {
    if (!identity) {
        console.warn('[sync] initiateOffer() called before identity was loaded, aborting');
        return;
    }
    const roomId = await calculateRoomId(identity.user_id, peerUserId);
    suppressReconnect.delete(peerNodeId);
    await ensurePeerConnection(peerNodeId, roomId, peerDisplayName, { initiate: true, force: true });
}

export async function sendPairRequest(peerNodeId: string): Promise<void> {
    if (!identity) {
        console.warn('[sync] sendPairRequest() called before identity was loaded, aborting');
        return;
    }
    syncStore.setPairingState('requesting');
    try {
        console.log(`[sync] sendPairRequest() -> ${peerNodeId}`);
        await invoke('mqtt_publish_pair_request', { peerNodeId });
    } catch (e) {
        console.error('[sync] Failed to send pair request:', e);
        syncStore.setPairingState(null);
    }
}

export async function respondToPairRequest(accept: boolean): Promise<void> {
    const req = get(pendingPairRequest);
    if (!req) {
        console.warn('[sync] respondToPairRequest() called with no pending request');
        return;
    }
    syncStore.setPendingPairRequest(null);
    try {
        if (accept) {
            console.log(`[sync] Accepting pair request from ${req.from}`);
            await invoke('mqtt_accept_pair_request', {
                peerNodeId: req.from,
                peerUserId: req.user_id,
                peerDisplayName: req.display_name,
            });
        } else {
            console.log(`[sync] Declining pair request from ${req.from}`);
            await invoke('mqtt_decline_pair_request', { peerNodeId: req.from });
        }
    } catch (e) {
        console.error('[sync] Failed to respond to pair request:', e);
    }
}

function sessionByRoom(roomId: string): PeerSession | undefined {
    for (const session of sessions.values()) {
        if (session.roomId === roomId) return session;
    }
    return undefined;
}

export function disconnectPeer(roomId: string): void {
    const session = sessionByRoom(roomId);
    if (session) {
        suppressReconnect.add(session.peerNodeId);
        teardownSession(session.peerNodeId);
    }
    syncStore.removeConnectedPeer(roomId);
}

export function disconnectAll(): void {
    for (const peerNodeId of [...sessions.keys()]) {
        teardownSession(peerNodeId);
    }
    syncStore.setConnectedPeers([]);
}

// --- lifecycle -----------------------------------------------------

export async function initSync(): Promise<void> {
    console.log('[sync] initSync() starting...');
    try {
        identity = await invoke<UserIdentity>('get_identity');
        console.log(`[sync] Local identity: node_id=${identity.node_id} user_id=${identity.user_id} display_name=${identity.display_name}`);
        syncStore.setIdentity(identity);

        await setupEventListeners();

        // One-time hash backfill for rows written before the hashing code existed.
        void repo.backfillHashes().catch((e) => console.warn('[sync] hash backfill failed:', e));

        const mqttBroker = await invoke<string | null>('get_mqtt_broker_url');
        console.log(`[sync] MQTT broker URL from config: ${mqttBroker || '(none)'}`);
        if (mqttBroker && mqttBroker.trim() !== '') {
            syncStore.setSignalingUrl(mqttBroker);
            syncStore.setSignalingStatus('connecting');
            try {
                console.log(`[sync] Connecting to MQTT broker ${mqttBroker}...`);
                await invoke('mqtt_connect', { brokerUrl: mqttBroker });
            } catch (e) {
                console.error('[sync] Failed to connect to MQTT broker:', e);
                syncStore.setSignalingStatus('error');
            }
        } else {
            console.warn('[sync] No MQTT broker URL configured, signaling will not start');
            syncStore.setSignalingStatus('disconnected');
        }

        await refreshPairedDevices();

        if (get(signalingStatus) === 'connected') {
            void reconnectAllPairedDevices('init');
        }

        console.log('[sync] initSync() complete, event listeners active');
    } catch (error) {
        console.error('[sync] Failed to init sync:', error);
        syncStore.setSignalingStatus('error');
    }
}

async function setupEventListeners(): Promise<void> {
    console.log('[sync] Registering Tauri event listeners');

    const unlistenPairRequest = await listen<{ from: string; user_id: string; display_name: string }>('mqtt-pair-request-received', (event) => {
        console.log(`[sync] event: mqtt-pair-request-received from=${event.payload.from} display_name=${event.payload.display_name}`);
        syncStore.setPendingPairRequest(event.payload);
    });

    const unlistenPairResponse = await listen<{ from: string; user_id: string; display_name: string; accepted: boolean }>('mqtt-pair-response-received', async (event) => {
        const { from, user_id, display_name, accepted } = event.payload;
        console.log(`[sync] event: mqtt-pair-response-received from=${from} accepted=${accepted}`);
        if (accepted) {
            syncStore.setPairingState(null);
            await initiateOffer(from, user_id, display_name);
        } else {
            syncStore.setPairingState('declined');
        }
    });

    const unlistenOffer = await listen<{ from: string; sdp: string; room_id: string; display_name: string }>('mqtt-offer-received', async (event) => {
        const { from, sdp, room_id, display_name } = event.payload;
        console.log(`[sync] event: mqtt-offer-received from=${from} room_id=${room_id}`);
        try {
            const { epoch, description } = parseDescPayload(sdp);
            await handleDescription(from, { epoch, description, roomId: room_id, displayName: display_name });
        } catch (e) {
            console.error(`[sync] [${from}] bad offer payload:`, e);
        }
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string }>('mqtt-answer-received', async (event) => {
        const { from, sdp } = event.payload;
        console.log(`[sync] event: mqtt-answer-received from=${from}`);
        try {
            const { epoch, description } = parseDescPayload(sdp);
            await handleDescription(from, { epoch, description });
        } catch (e) {
            console.error(`[sync] [${from}] bad answer payload:`, e);
        }
    });

    const unlistenIce = await listen<{ from: string; candidate: string }>('mqtt-ice-candidate-received', async (event) => {
        const { from, candidate } = event.payload;
        console.log(`[sync] event: mqtt-ice-candidate-received from=${from}`);
        try {
            const { epoch, candidate: cand } = parseIcePayload(candidate);
            await handleIceCandidate(from, { epoch, candidate: cand });
        } catch (e) {
            console.error(`[sync] [${from}] bad ICE payload:`, e);
        }
    });

    const unlistenStatus = await listen<string>('mqtt-status', (event) => {
        const next = event.payload as SignalingStatus;
        const prev = get(signalingStatus);
        console.log(`[sync] event: mqtt-status -> ${next} (was ${prev})`);
        syncStore.setSignalingStatus(next);
        if (next === 'connected' && prev !== 'connected') {
            void reconnectAllPairedDevices('mqtt-connected');
        } else if (next === 'disconnected' || next === 'error') {
            pauseAllReconnects();
        }
    });

    cleanupFns = [unlistenPairRequest, unlistenPairResponse, unlistenOffer, unlistenAnswer, unlistenIce, unlistenStatus];
    console.log('[sync] Event listeners registered');
}

export function shutdownSync(): void {
    console.warn(`[sync] shutdownSync() - tearing down ${cleanupFns.length} listener(s) and disconnecting all rooms.`);
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    disconnectAll();
    suppressReconnect.clear();
}
