import { log } from '$lib/log';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import {
    syncStore,
    pendingPairRequest,
    pairingState,
    canSignal,
    lanStatus,
    lanPeerIds,
    addressPeerIds,
    endpointPeerIds,
    pairedDevices,
    connectedPeers,
    type UserIdentity,
    type DevicePair,
    type LanStatus,
    type Peer,
    type PeerSource,
} from '../stores/sync';
import { refreshEndpoints, saveEndpoint } from './endpoints';
import { isObfuscated, rewriteCandidate } from './iceRewrite';
import { DocumentRepository } from './DocumentRepository';
import { attachFraming, type FramedChannel } from './channel/Framing';
import { DocSyncProtocol, type SyncProgressSink } from './channel/DocSyncProtocol';
import { isSyncMessage, type SyncMessage } from './protocol';
import {
    admitEnvelope,
    parseDescPayload,
    parseIcePayload,
    serializeDesc,
    serializeIce,
    type DescEnvelope,
    type IceEnvelope,
} from './signaling/envelope';
import { isPolite as politeAgainst, reconnectDelay, shouldSweep } from './signaling/negotiation';
import { canReachForPairing, unreachableForPairing, type ReachInputs } from './pairReach';

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
    // `epoch` is our own negotiation generation, bumped on every local rebuild so
    // the peer can drop messages from a superseded negotiation of ours.
    // `peerEpoch` is the highest epoch we have seen *from* the peer, and
    // `peerBoot` says which run of the peer produced it. Incoming messages are
    // stale only if they go backwards within one run: the two counters advance
    // independently (a manual reconnect rebuilds one side many more times than
    // the other), and they restart when the peer's process does. See
    // signaling/envelope.ts.
    epoch: number;
    peerEpoch: number;
    peerBoot: string | null;
    makingOffer: boolean;
    ignoreOffer: boolean;
    isSettingRemoteAnswerPending: boolean;
    dataChannel: RTCDataChannel | null;
    // Our own address as this peer would see it, for rewriting obfuscated ICE
    // candidates (ADR 0023). Null when the peer is on this network, where the
    // mDNS candidate name resolves and nothing needs rewriting.
    localAddress: string | null;
    framed: FramedChannel | null;
    proto: DocSyncProtocol | null;
    reconnectAttempts: number;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    promoteTimer?: ReturnType<typeof setTimeout>;
    negotiationTimer?: ReturnType<typeof setTimeout>;
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
// (e.g. it has only just found us on the network).
const PROMOTE_TIMEOUT_MS = 6_000;
// How long a connection may sit mid-negotiation before it is rebuilt.
//
// A handshake that never completes leaves nothing to react to. With our offer
// sent and the answer lost, the connection stays in 'new' indefinitely: ICE
// never fails because no remote description was ever set, no state change
// fires, and the reconnect sweep skips it precisely because 'new' looks like a
// connection still in progress. If we are the impolite peer we also reject the
// peer's own offers as collisions. One lost answer therefore wedged that peer
// until the user pressed Reconnect.
const NEGOTIATION_TIMEOUT_MS = 30_000;
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

// Deterministic, needs no exchange: node_ids are unique and both devices
// compute the same answer. The rule itself is in signaling/negotiation.ts,
// where it is tested; this only supplies our own id.
function isPolite(peerNodeId: string): boolean {
    return !!identity && politeAgainst(identity.node_id, peerNodeId);
}

function markPeerReconnecting(peerNodeId: string, reconnecting: boolean): void {
    syncStore.setPeerReconnecting(peerNodeId, reconnecting);
}

// Rebuild the session if it has not finished connecting in time. Routed
// through `scheduleReconnect` so it inherits the backoff and every guard that
// already applies to a dropped connection: an explicit disconnect, signaling
// being down, the pair having been removed, and a retry already pending.
function armNegotiationWatchdog(session: PeerSession): void {
    if (session.negotiationTimer) return;
    session.negotiationTimer = setTimeout(() => {
        session.negotiationTimer = undefined;
        if (sessions.get(session.peerNodeId) !== session) return;
        if (session.pc.connectionState === 'connected') return;
        console.warn(
            `[sync] [${session.peerNodeId}] negotiation stalled in '${session.pc.connectionState}', rebuilding`,
        );
        scheduleReconnect(session.peerNodeId);
    }, NEGOTIATION_TIMEOUT_MS);
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

// Also the revival signal: a peer holding a tombstone for this id clears it
// when `lifecycleUpdatedAt` is newer than the stamp on its own tombstone.
export function broadcastDocCreated(entry: {
    id: string;
    docType: string;
    title: string;
    titleUpdatedAt: number;
    createdAt: number;
    lifecycleUpdatedAt: number;
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
            lifecycleUpdatedAt: entry.lifecycleUpdatedAt,
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

// The editor calls this right after it saves a newly inserted image, so
// connected peers pull the bytes without waiting for the next reconnect.
export function broadcastAttachmentAvailable(hash: string, mime: string, size: number): void {
    broadcast({ t: 'attach-manifest', items: [{ hash, mime, size }] });
}

// The image node view calls this when it renders a reference whose bytes are
// missing locally - ask every connected peer for them.
export function pullAttachmentFromPeers(hash: string): void {
    for (const { proto } of openProtos()) {
        proto.requestAttachment(hash);
    }
}

// --- transport helpers ---------------------------------------------------

async function sendDescription(
    peerId: string,
    session: PeerSession,
    desc: RTCSessionDescription,
): Promise<void> {
    const payload = serializeDesc(session.epoch, desc.toJSON());
    const cmd = desc.type === 'answer' ? 'signaling_publish_answer' : 'signaling_publish_offer';
    log.debug(`[sync] [${peerId}] -> ${desc.type} (epoch=${session.epoch})`);
    try {
        await invoke(cmd, { peerId, sdp: payload });
    } catch (e) {
        console.error(`[sync] [${peerId}] Failed to publish ${desc.type}:`, e);
    }
}

async function sendIceCandidate(
    peerId: string,
    session: PeerSession,
    candidate: RTCIceCandidate,
): Promise<void> {
    const init = candidate.toJSON();
    await publishIce(peerId, session, init);

    // A peer that is not on this network cannot resolve an mDNS candidate
    // name, so the candidate as the WebView produced it is dead on arrival
    // there. Publish a copy naming the address that peer would reach us at
    // (ADR 0023). The original goes out either way: it is the working one for
    // anyone who can resolve it, and ICE discards what does not check out.
    if (!session.localAddress || !isObfuscated(init.candidate ?? '')) return;
    const rewritten = rewriteCandidate(init, session.localAddress);
    if (!rewritten) return;
    log.debug(`[sync] [${peerId}] also publishing that candidate as ${session.localAddress}`);
    await publishIce(peerId, session, rewritten);
}

async function publishIce(
    peerId: string,
    session: PeerSession,
    init: RTCIceCandidateInit,
): Promise<void> {
    const payload = serializeIce(session.epoch, init);
    await invoke('signaling_publish_ice_candidate', { peerId, candidate: payload }).catch((e) =>
        console.error(`[sync] [${peerId}] Failed to publish ICE candidate:`, e),
    );
}

// The address this peer would reach us at, when it is not on this network.
//
// Read once per session rather than per candidate: candidates arrive in a
// burst, and the answer is a property of the route, which does not change
// under a session without the session being rebuilt.
async function localAddressToward(peerNodeId: string): Promise<string | null> {
    if (get(lanPeerIds).has(peerNodeId)) return null;
    try {
        return await invoke<string | null>('local_address_toward', { peerNodeId });
    } catch (e) {
        console.warn(`[sync] [${peerNodeId}] could not work out our address toward it:`, e);
        return null;
    }
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
    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = undefined;
    }
    if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = undefined;
    }
    if (session.promoteTimer) {
        clearTimeout(session.promoteTimer);
        session.promoteTimer = undefined;
    }
    if (session.negotiationTimer) {
        clearTimeout(session.negotiationTimer);
        session.negotiationTimer = undefined;
    }
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
    log.debug(`[sync] teardownSession(${peerNodeId}) keepAttempts=${!!opts.keepAttempts}`);
    clearSessionTimers(session);
    disposeChannel(session);
    try {
        session.dataChannel?.close();
    } catch {
        /* noop */
    }
    try {
        session.pc.onnegotiationneeded = null;
        session.pc.onicecandidate = null;
        session.pc.oniceconnectionstatechange = null;
        session.pc.onconnectionstatechange = null;
        session.pc.ondatachannel = null;
        session.pc.close();
    } catch {
        /* noop */
    }
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
            // A sweep leaves a session that looks in-progress alone, so make
            // sure something is still watching it. `pauseAllReconnects` clears
            // the watchdog when signaling drops, and the recovery sweep comes
            // back through here.
            if (st !== 'connected') armNegotiationWatchdog(existing);
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
        peerEpoch: existing?.peerEpoch ?? 0,
        peerBoot: existing?.peerBoot ?? null,
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        dataChannel: null,
        localAddress: null,
        framed: null,
        proto: null,
        reconnectAttempts: existing?.reconnectAttempts ?? 0,
    };
    sessions.set(peerNodeId, session);
    syncStore.setRoomSyncPhase(roomId, 'connecting');
    markPeerReconnecting(peerNodeId, true);
    armNegotiationWatchdog(session);

    log.debug(
        `[sync] ensurePeerConnection() -> ${displayName} (peer=${peerNodeId}, room=${roomId}, polite=${polite}, initiate=${opts.initiate}, epoch=${session.epoch})`,
    );

    pc.onnegotiationneeded = async () => {
        try {
            session.makingOffer = true;
            await pc.setLocalDescription();
            if (pc.localDescription)
                await sendDescription(peerNodeId, session, pc.localDescription);
        } catch (e) {
            console.error(`[sync] [${peerNodeId}] negotiationneeded failed:`, e);
        } finally {
            session.makingOffer = false;
        }
    };

    // Started before the offer and not awaited: candidates cannot be gathered
    // until a description is set, so this has resolved long before the first
    // one arrives, and a session must not wait on a command to exist.
    void localAddressToward(peerNodeId).then((addr) => {
        session.localAddress = addr;
    });

    pc.onicecandidate = ({ candidate }) => {
        if (candidate) void sendIceCandidate(peerNodeId, session, candidate);
    };

    pc.oniceconnectionstatechange = () => {
        log.debug(`[sync] [${peerNodeId}] iceConnectionState -> ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            try {
                pc.restartIce();
            } catch (e) {
                console.warn(`[sync] [${peerNodeId}] restartIce() failed:`, e);
            }
        }
    };

    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        log.debug(`[sync] [${peerNodeId}] connectionState -> ${st} (room=${roomId})`);
        if (st === 'connected') {
            session.reconnectAttempts = 0;
            clearSessionTimers(session);
            markPeerReconnecting(peerNodeId, false);
            syncStore.addConnectedPeer({
                peer_node_id: peerNodeId,
                peer_display_name: displayName,
                room_id: roomId,
            });
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
        log.debug(`[sync] [${peerNodeId}] Remote data channel '${channel.label}' (room=${roomId})`);
        wireDataChannel(channel, session);
    };

    if (opts.initiate) {
        const channel = pc.createDataChannel('yjs-sync', { ordered: true }); // fires onnegotiationneeded
        wireDataChannel(channel, session);
    } else if (polite) {
        session.promoteTimer = setTimeout(() => {
            session.promoteTimer = undefined;
            if (
                sessions.get(peerNodeId) === session &&
                pc.connectionState !== 'connected' &&
                !session.dataChannel
            ) {
                log.debug(`[sync] [${peerNodeId}] promotion timeout - initiating`);
                void ensurePeerConnection(peerNodeId, roomId, displayName, {
                    initiate: true,
                    force: true,
                });
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
        onProgress: (pending, total) =>
            syncStore.setRoomSyncProgress(session.roomId, pending, total),
        onSynced: (at) => {
            syncStore.markRoomSynced(session.roomId, at);
            invoke('update_pair_sync_time', { roomId: session.roomId })
                .then(refreshPairedDevices)
                .catch((e) =>
                    console.error(
                        `[sync] [${session.peerNodeId}] update_pair_sync_time failed:`,
                        e,
                    ),
                );
        },
    };

    // A send that never reached the channel is worth knowing about: the peer
    // will never answer it, and without this it looked exactly like a peer
    // that chose not to.
    const proto = new DocSyncProtocol(
        repo,
        (m) => {
            void session.framed?.send(m).then((sent) => {
                if (!sent) {
                    console.warn(
                        `[sync] [${session.peerNodeId}] could not send '${(m as { t?: string }).t}'`,
                    );
                }
            });
        },
        sink,
    );
    const framed = attachFraming(channel, (m) => {
        if (isSyncMessage(m)) {
            void proto
                .handle(m)
                .catch((e) =>
                    console.error(`[sync] [room=${session.roomId}] handle('${m.t}') failed:`, e),
                );
        }
    });
    session.proto = proto;
    session.framed = framed;

    channel.onopen = () => {
        log.debug(
            `[sync] DataChannel open for room ${session.roomId} (peer=${session.peerNodeId})`,
        );
        markPeerReconnecting(session.peerNodeId, false);
        syncStore.addConnectedPeer({
            peer_node_id: session.peerNodeId,
            peer_display_name: session.displayName,
            room_id: session.roomId,
        });
        void proto.start();
    };

    channel.onclose = () => {
        log.debug(
            `[sync] DataChannel closed for room ${session.roomId} (peer=${session.peerNodeId})`,
        );
        disposeChannel(session);
        syncStore.removeConnectedPeer(session.roomId);
        syncStore.setRoomSyncPhase(session.roomId, 'idle');
        if (session.pc.connectionState !== 'closed') {
            scheduleReconnect(session.peerNodeId);
        }
    };

    channel.onerror = (event) => {
        console.error(
            `[sync] DataChannel error for room ${session.roomId} (peer=${session.peerNodeId}):`,
            event,
        );
    };
}

// --- perfect-negotiation description / ICE handlers -------------------

async function handleDescription(from: string, env: DescEnvelope): Promise<void> {
    let session = sessions.get(from);

    if (!session) {
        if (env.description.type !== 'offer') {
            console.warn(
                `[sync] [${from}] stray ${env.description.type} with no session, dropping`,
            );
            return;
        }
        if (!env.roomId) {
            console.warn(`[sync] [${from}] offer without room_id, dropping`);
            return;
        }
        // "Disconnect" has to mean disconnected, not "disconnected until the
        // peer's next reconnect sweep". Suppression only held back our own
        // outbound attempts, so the peer reconnected us within seconds and the
        // button looked broken. Reconnect clears the suppression.
        if (suppressReconnect.has(from)) {
            log.debug(`[sync] [${from}] offer ignored, peer was explicitly disconnected`);
            return;
        }
        const built = await ensurePeerConnection(from, env.roomId, env.displayName || from, {
            initiate: false,
        });
        if (!built) return;
        session = built;
    }

    if (admitEnvelope(session, env) === 'stale') {
        log.debug(
            `[sync] [${from}] ignoring stale description (epoch ${env.epoch} < peerEpoch ${session.peerEpoch})`,
        );
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
    if (admitEnvelope(session, env) === 'stale') return;
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
    if (!get(canSignal)) return;

    const pair = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
    if (!pair) {
        teardownSession(peerNodeId);
        return;
    }

    const attempt = session.reconnectAttempts;
    session.reconnectAttempts = attempt + 1;
    // Jittered, or two devices that dropped together retry in lockstep and
    // every retry is a fresh collision.
    const delay = reconnectDelay(attempt, jitter(0, 1000));
    log.debug(`[sync] [${peerNodeId}] reconnect attempt ${attempt + 1} in ${Math.round(delay)}ms`);
    markPeerReconnecting(peerNodeId, true);

    session.reconnectTimer = setTimeout(() => {
        session.reconnectTimer = undefined;
        const current = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
        if (!current) {
            teardownSession(peerNodeId);
            return;
        }
        if (suppressReconnect.has(peerNodeId) || !get(canSignal)) return;
        void ensurePeerConnection(
            current.peer_node_id,
            current.room_id,
            current.peer_display_name,
            {
                initiate: !isPolite(peerNodeId),
                force: true,
            },
        );
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
    if (!get(canSignal)) {
        console.warn(`[sync] reconnectPeer(${peerNodeId}) ignored - discovery is not running`);
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
        if (
            existing.pc.connectionState === 'connected' &&
            existing.dataChannel?.readyState === 'open'
        ) {
            log.debug(`[sync] reconnectPeer(${peerNodeId}) - already connected, ignoring`);
            return;
        }
        clearSessionTimers(existing);
        existing.reconnectAttempts = 0;
    }

    // Initiate unconditionally (even when we are the polite peer): the user asked
    // for a connection *now*, so we should not sit on the promote timeout waiting
    // for the other side to offer. Perfect negotiation resolves the collision if
    // both peers do this at once. Matches initiateOffer() on the pairing path.
    log.debug(`[sync] reconnectPeer(${peerNodeId}) - forcing immediate reconnect`);
    markPeerReconnecting(peerNodeId, true);
    await ensurePeerConnection(pair.peer_node_id, pair.room_id, pair.peer_display_name, {
        initiate: true,
        force: true,
    });
}

export async function reconnectAllPairedDevices(reason: string): Promise<void> {
    if (!identity || sweepRunning) return;
    if (!get(canSignal)) return;
    sweepRunning = true;
    log.debug(`[sync] reconnectAllPairedDevices(${reason})`);
    try {
        await refreshPairedDevices();
        const connectedRooms = new Set(get(connectedPeers).map((p) => p.room_id));
        for (const pair of get(pairedDevices)) {
            const existing = sessions.get(pair.peer_node_id);
            const take = shouldSweep({
                peerNodeId: pair.peer_node_id,
                roomId: pair.room_id,
                connected: connectedRooms.has(pair.room_id),
                connectionState: existing?.pc.connectionState,
                suppressed: suppressReconnect.has(pair.peer_node_id),
            });
            if (!take) continue;
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

export async function initiateOffer(
    peerNodeId: string,
    peerUserId: string,
    peerDisplayName: string,
): Promise<void> {
    if (!identity) {
        console.warn('[sync] initiateOffer() called before identity was loaded, aborting');
        return;
    }
    const roomId = await calculateRoomId(identity.user_id, peerUserId);
    suppressReconnect.delete(peerNodeId);
    await ensurePeerConnection(peerNodeId, roomId, peerDisplayName, {
        initiate: true,
        force: true,
    });
}

// How long to wait for the other device to answer a pair request.
//
// Long enough that someone has to walk to the other device and tap Accept,
// short enough that an unanswered request does not look like a hung app.
// Without it the button read "Requesting..." until the app was restarted, and
// the id the user typed had already been cleared from the field, so there was
// nothing to retry with.
const PAIR_REQUEST_TIMEOUT_MS = 90_000;

// How long to let discovery catch up before giving up on a pair request.
//
// Pairing over the local network needs the other device to have been found,
// which mDNS usually manages in a second or two but not instantly. Someone who
// opens both apps and types an id straight away would otherwise be told there
// is no route, when waiting a moment is all that was needed. Short enough that
// a genuinely absent device is reported quickly.
const PAIR_DISCOVERY_WAIT_MS = 10_000;

// How long to wait when an address was typed along with the id.
//
// Longer, because the answer comes from a probe rather than from a packet that
// was already on its way: a connection attempt, a round trip, and possibly a
// dead address ahead of this one in the same pass, each costing its connect
// timeout. Still short enough that a wrong address is reported while the
// person who typed it is still looking at the screen.
const PAIR_ADDRESS_WAIT_MS = 20_000;
let pairRequestTimer: ReturnType<typeof setTimeout> | null = null;

function reachInputs(peerNodeId: string): ReachInputs {
    return {
        onLocalNetwork: get(lanPeerIds).has(peerNodeId),
        discovering: get(lanStatus) === 'active',
        onStoredAddress: get(addressPeerIds).has(peerNodeId),
        hasStoredAddress: get(endpointPeerIds).has(peerNodeId),
    };
}

// Resolves as soon as this peer can be reached, or false if it cannot inside
// the wait. Driven by the store rather than by polling, so a device that
// appears after half a second is paired with after half a second.
function waitForPairRoute(peerNodeId: string, waitMs: number): Promise<boolean> {
    if (canReachForPairing(reachInputs(peerNodeId))) return Promise.resolve(true);

    return new Promise((resolve) => {
        let done = false;
        let unsubscribe: (() => void) | null = null;
        const finish = (reachable: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve(reachable);
        };
        const timer = setTimeout(() => finish(false), waitMs);
        unsubscribe = syncStore.subscribe(() => {
            if (canReachForPairing(reachInputs(peerNodeId))) finish(true);
        });
        // `subscribe` calls back once synchronously, while `unsubscribe` is
        // still null, so the subscription is dropped here instead.
        if (done) unsubscribe();
    });
}

function clearPairRequestTimer(): void {
    if (pairRequestTimer) {
        clearTimeout(pairRequestTimer);
        pairRequestTimer = null;
    }
}

/**
 * Ask a device to pair, optionally telling this one where to find it.
 *
 * `address` is for a device that is not on this network (ADR 0023). It is
 * stored first and probed at once, so that pairing with a device over a VPN is
 * one action with one id in it rather than two of each.
 */
export async function sendPairRequest(
    peerNodeId: string,
    opts: { address?: string } = {},
): Promise<void> {
    if (!identity) {
        console.warn('[sync] sendPairRequest() called before identity was loaded, aborting');
        return;
    }
    clearPairRequestTimer();
    syncStore.setPairingState('requesting');

    const address = opts.address?.trim();
    if (address) {
        try {
            const saved = await saveEndpoint(peerNodeId, address);
            log.debug(`[sync] pairing with ${peerNodeId} at ${saved.host}:${saved.port}`);
        } catch (e) {
            // A malformed address is the user's typo, and Rust's message says
            // which part it could not read. Nothing was stored, so there is
            // nothing to undo.
            syncStore.setPairingState(null);
            throw e;
        }
    }

    // Wait for the other device to be found before deciding it cannot be
    // reached. Being found is the only way to it, and neither discovery nor a
    // probe is instant.
    const waitMs = address ? PAIR_ADDRESS_WAIT_MS : PAIR_DISCOVERY_WAIT_MS;
    if (!(await waitForPairRoute(peerNodeId, waitMs))) {
        const reason = unreachableForPairing(reachInputs(peerNodeId));
        log.debug(`[sync] sendPairRequest(${peerNodeId}) has no route: ${reason}`);
        syncStore.setPairingState(null);
        throw new Error(reason);
    }

    try {
        log.debug(`[sync] sendPairRequest() -> ${peerNodeId}`);
        await invoke('signaling_publish_pair_request', { peerNodeId });
    } catch (e) {
        console.error('[sync] Failed to send pair request:', e);
        syncStore.setPairingState(null);
        throw e;
    }

    pairRequestTimer = setTimeout(() => {
        pairRequestTimer = null;
        if (get(pairingState) === 'requesting') {
            log.debug(`[sync] pair request to ${peerNodeId} went unanswered`);
            syncStore.setPairingState('timed-out');
        }
    }, PAIR_REQUEST_TIMEOUT_MS);
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
            log.debug(`[sync] Accepting pair request from ${req.from}`);
            await invoke('signaling_accept_pair_request', {
                peerNodeId: req.from,
                peerUserId: req.user_id,
                peerDisplayName: req.display_name,
            });
        } else {
            log.debug(`[sync] Declining pair request from ${req.from}`);
            await invoke('signaling_decline_pair_request', { peerNodeId: req.from });
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
    log.debug('[sync] initSync() starting...');
    try {
        identity = await invoke<UserIdentity>('get_identity');
        log.debug(
            `[sync] Local identity: node_id=${identity.node_id} user_id=${identity.user_id} display_name=${identity.display_name}`,
        );
        syncStore.setIdentity(identity);

        await setupEventListeners();

        // One-time hash backfill for rows written before the hashing code existed.
        void repo.backfillHashes().catch((e) => console.warn('[sync] hash backfill failed:', e));

        await startSignaling();

        await finishInit();
    } catch (error) {
        console.error('[sync] Failed to init sync:', error);
        syncStore.setLanStatus('error');
    }
}

async function finishInit(): Promise<void> {
    await refreshPairedDevices();

    if (get(canSignal)) {
        void reconnectAllPairedDevices('init');
    }

    log.debug('[sync] initSync() complete, event listeners active');
}

// Start listening, and start both ways of finding a peer: this network, and
// the addresses the user has stored (ADR 0023).
//
// Discovery failing is no longer the end of it. A device with no mDNS at all -
// iOS, or a firewall prompt nobody answered - still syncs with whatever it has
// an address for, so the failure is reported and the listener stays up. Only
// the listener itself failing means no sync at all.
async function startSignaling(): Promise<void> {
    try {
        const { port, on_default_port, discovery_error } = await invoke<{
            port: number;
            on_default_port: boolean;
            discovery_error: string | null;
        }>('signaling_start');
        syncStore.setListener(port, on_default_port);
        log.debug(
            `[sync] signaling listening on port ${port}${on_default_port ? '' : ' (not the default port, so a stored address cannot reach this device)'}`,
        );
        if (discovery_error) {
            console.warn('[sync] local network discovery unavailable:', discovery_error);
        }
        // Seeds the list from whatever is already known, which matters when
        // sync is restarted rather than started.
        syncStore.setPeers(await invoke<Peer[]>('list_reachable_peers'));
        await refreshEndpoints();
    } catch (e) {
        console.warn('[sync] sync transport unavailable:', e);
        syncStore.setLanStatus('error');
    }
}

async function setupEventListeners(): Promise<void> {
    log.debug('[sync] Registering Tauri event listeners');

    const unlistenPairRequest = await listen<{
        from: string;
        user_id: string;
        display_name: string;
    }>('signaling-pair-request-received', (event) => {
        log.debug(
            `[sync] event: pair-request from=${event.payload.from} display_name=${event.payload.display_name}`,
        );
        syncStore.setPendingPairRequest(event.payload);
    });

    const unlistenPairResponse = await listen<{
        from: string;
        user_id: string;
        display_name: string;
        accepted: boolean;
    }>('signaling-pair-response-received', async (event) => {
        const { from, user_id, display_name, accepted } = event.payload;
        log.debug(`[sync] event: pair-response from=${from} accepted=${accepted}`);
        clearPairRequestTimer();
        if (accepted) {
            syncStore.setPairingState(null);
            await initiateOffer(from, user_id, display_name);
        } else {
            syncStore.setPairingState('declined');
        }
    });

    const unlistenOffer = await listen<{
        from: string;
        sdp: string;
        room_id: string;
        display_name: string;
    }>('signaling-offer-received', async (event) => {
        const { from, sdp, room_id, display_name } = event.payload;
        log.debug(`[sync] event: offer from=${from} room_id=${room_id}`);
        try {
            const { boot, epoch, description } = parseDescPayload(sdp);
            await handleDescription(from, {
                boot,
                epoch,
                description,
                roomId: room_id,
                displayName: display_name,
            });
        } catch (e) {
            console.error(`[sync] [${from}] bad offer payload:`, e);
        }
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string }>(
        'signaling-answer-received',
        async (event) => {
            const { from, sdp } = event.payload;
            log.debug(`[sync] event: answer from=${from}`);
            try {
                const { boot, epoch, description } = parseDescPayload(sdp);
                await handleDescription(from, { boot, epoch, description });
            } catch (e) {
                console.error(`[sync] [${from}] bad answer payload:`, e);
            }
        },
    );

    const unlistenIce = await listen<{ from: string; candidate: string }>(
        'signaling-ice-candidate-received',
        async (event) => {
            const { from, candidate } = event.payload;
            log.debug(`[sync] event: ice-candidate from=${from}`);
            try {
                const { boot, epoch, candidate: cand } = parseIcePayload(candidate);
                await handleIceCandidate(from, { boot, epoch, candidate: cand });
            } catch (e) {
                console.error(`[sync] [${from}] bad ICE payload:`, e);
            }
        },
    );

    const unlistenLanStatus = await listen<string>('lan-status', (event) => {
        const next = event.payload as LanStatus;
        const prev = get(lanStatus);
        log.debug(`[sync] event: lan-status -> ${next} (was ${prev})`);
        syncStore.setLanStatus(next);
        if (next === 'active' && prev !== 'active') {
            void reconnectAllPairedDevices('lan-active');
        } else if (next !== 'active' && !get(canSignal)) {
            // Discovery going down is only the end of it when nothing is
            // reachable at a stored address either. Otherwise there is still
            // somewhere for a backoff tick to go (ADR 0023).
            pauseAllReconnects();
        }
    });

    const unlistenPeerFound = await listen<Peer>('peer-found', (event) => {
        const peer = event.payload;
        log.debug(
            `[sync] event: peer-found ${peer.node_id} via ${peer.source} at ${peer.addrs.join(', ')}:${peer.port}`,
        );
        syncStore.addPeer(peer);
        // A device we are paired with just became reachable, so try it now
        // rather than at the next backoff tick. A peer that is already
        // connected is left alone; the sweep skips it.
        if (get(pairedDevices).some((p) => p.peer_node_id === peer.node_id)) {
            void reconnectAllPairedDevices('peer-found');
        }
    });

    const unlistenPeerLost = await listen<{ node_id: string; source: PeerSource }>(
        'peer-lost',
        (event) => {
            const { node_id, source } = event.payload;
            log.debug(`[sync] event: peer-lost ${node_id} via ${source}`);
            syncStore.removePeer(node_id, source);
        },
    );

    cleanupFns = [
        unlistenPairRequest,
        unlistenPairResponse,
        unlistenOffer,
        unlistenAnswer,
        unlistenIce,
        unlistenLanStatus,
        unlistenPeerFound,
        unlistenPeerLost,
    ];
    log.debug('[sync] Event listeners registered');
}

export function shutdownSync(): void {
    console.warn(
        `[sync] shutdownSync() - tearing down ${cleanupFns.length} listener(s) and disconnecting all rooms.`,
    );
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    clearPairRequestTimer();
    disconnectAll();
    suppressReconnect.clear();
    // Stop advertising before the window goes: a peer acting on an
    // advertisement we left behind would find a closed port.
    void invoke('signaling_stop').catch((e) => console.warn('[sync] signaling_stop failed:', e));
    syncStore.setLanStatus('off');
}
