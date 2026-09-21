import { log } from '$lib/log';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import {
    syncStore,
    pendingPairRequest,
    pairingState,
    brokerStatus,
    canSignal,
    lanStatus,
    lanPeerIds,
    syncMode,
    pairedDevices,
    connectedPeers,
    type UserIdentity,
    type DevicePair,
    type BrokerStatus,
    type LanStatus,
    type LanPeer,
    type SignalingRoute,
    type SyncMode,
} from '../stores/sync';
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
    framed: FramedChannel | null;
    proto: DocSyncProtocol | null;
    // Which transport last carried signaling for this peer. Null until the
    // first message goes out or arrives; the backend picks the route, so this
    // is what it reports back rather than what we asked for.
    route: SignalingRoute | null;
    reconnectAttempts: number;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    graceTimer?: ReturnType<typeof setTimeout>;
    promoteTimer?: ReturnType<typeof setTimeout>;
    negotiationTimer?: ReturnType<typeof setTimeout>;
    lanTimer?: ReturnType<typeof setTimeout>;
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
// How long to wait for a connection negotiated over the local network before
// giving up on that route and letting the backoff try the broker.
//
// A local handshake that is going to work is done well inside a second: there
// is no relay, nothing reflexive to gather, and the peer is a few milliseconds
// away. Thirty seconds is the right patience for a connection through the
// internet and far too much for this one, and every second of it is a second
// the peer is not syncing.
const LAN_ATTEMPT_TIMEOUT_MS = 8_000;

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

// Whether there is another way to reach a peer if the local route does not
// work out.
//
// Without one, giving up on the local network is giving up. The peer cannot
// even be sent an answer to the offer it just delivered, every message fails
// with "no signaling route", and the only route that could have worked is
// torn down every eight seconds while both devices sit at "Connecting...".
// The broker has to be connected, not merely configured: one that is timing
// out is not a fallback.
function hasFallbackRoute(): boolean {
    return get(syncMode) !== 'local-only' && get(brokerStatus) === 'connected';
}

// Record which transport just carried signaling for this peer, and put the
// local network on a short fuse when it was that and there is somewhere else
// to go.
function noteRoute(session: PeerSession, route: SignalingRoute): void {
    if (sessions.get(session.peerNodeId) !== session) return;
    session.route = route;
    if (route === 'lan' && hasFallbackRoute()) {
        armLanWatchdog(session);
    } else if (session.lanTimer) {
        clearTimeout(session.lanTimer);
        session.lanTimer = undefined;
    }
}

// Stop waiting on a local route that is not connecting.
//
// The backend already notices a refused connection, which covers a peer that
// has left the network. This covers the other half: the message was taken and
// the connection still never formed, which nothing about the socket reveals.
// Telling the backend is what sends the retry over the broker, since the peer
// is then in a cooldown when the next message is routed.
function armLanWatchdog(session: PeerSession): void {
    if (session.lanTimer) return;
    session.lanTimer = setTimeout(() => {
        session.lanTimer = undefined;
        if (sessions.get(session.peerNodeId) !== session) return;
        if (session.route !== 'lan') return;
        if (session.pc.connectionState === 'connected') return;
        // Re-checked rather than trusted from eight seconds ago: the broker
        // may have dropped since, and writing off the local route now would
        // leave this peer with nothing.
        if (!hasFallbackRoute()) {
            log.debug(
                `[sync] [${session.peerNodeId}] local network is the only route, staying on it`,
            );
            return;
        }
        console.warn(
            `[sync] [${session.peerNodeId}] local network did not connect in ${LAN_ATTEMPT_TIMEOUT_MS}ms, falling back`,
        );
        void invoke('signaling_note_route_failure', { peerNodeId: session.peerNodeId }).catch((e) =>
            console.error(`[sync] [${session.peerNodeId}] could not report the route failure:`, e),
        );
        scheduleReconnect(session.peerNodeId);
    }, LAN_ATTEMPT_TIMEOUT_MS);
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
        const route = await invoke<SignalingRoute>(cmd, { peerId, sdp: payload });
        log.debug(`[sync] [${peerId}] ${desc.type} went over ${route}`);
        noteRoute(session, route);
    } catch (e) {
        console.error(`[sync] [${peerId}] Failed to publish ${desc.type}:`, e);
    }
}

async function sendIceCandidate(
    peerId: string,
    session: PeerSession,
    candidate: RTCIceCandidate,
): Promise<void> {
    const payload = serializeIce(session.epoch, candidate.toJSON());
    await invoke('signaling_publish_ice_candidate', { peerId, candidate: payload }).catch((e) =>
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
    if (session.lanTimer) {
        clearTimeout(session.lanTimer);
        session.lanTimer = undefined;
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
        route: existing?.route ?? null,
        epoch: (existing?.epoch ?? 0) + 1,
        peerEpoch: existing?.peerEpoch ?? 0,
        peerBoot: existing?.peerBoot ?? null,
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
                route: session.route,
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
            route: session.route,
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

async function handleDescription(
    from: string,
    env: DescEnvelope,
    route?: SignalingRoute,
): Promise<void> {
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

    // How it reached us is how we should answer, and what we blame if the
    // connection never forms.
    if (route) noteRoute(session, route);

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
        console.warn(`[sync] reconnectPeer(${peerNodeId}) ignored - no signaling route`);
        return;
    }
    const pair = get(pairedDevices).find((p) => p.peer_node_id === peerNodeId);
    if (!pair) {
        console.warn(`[sync] reconnectPeer(${peerNodeId}) - no matching pair, ignoring`);
        return;
    }

    suppressReconnect.delete(peerNodeId);
    // The user asked for a connection now, so let the local network be tried
    // again even if it just failed. Sitting out the rest of a cooldown to
    // answer them would look like the button did nothing.
    await invoke('signaling_clear_route_failure', { peerNodeId }).catch((e) =>
        console.warn(`[sync] [${peerNodeId}] could not clear the route cooldown:`, e),
    );

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
let pairRequestTimer: ReturnType<typeof setTimeout> | null = null;

function reachInputs(peerNodeId: string): ReachInputs {
    const state = get(syncStore);
    return {
        onLocalNetwork: get(lanPeerIds).has(peerNodeId),
        brokerConfigured: !!state.brokerUrl,
        brokerStatus: state.brokerStatus,
        mode: state.syncMode,
    };
}

// Resolves as soon as this peer can be reached, or false if it cannot inside
// the wait. Driven by the store rather than by polling, so a device that
// appears after half a second is paired with after half a second.
function waitForPairRoute(peerNodeId: string): Promise<boolean> {
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
        const timer = setTimeout(() => finish(false), PAIR_DISCOVERY_WAIT_MS);
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

export async function sendPairRequest(peerNodeId: string): Promise<void> {
    if (!identity) {
        console.warn('[sync] sendPairRequest() called before identity was loaded, aborting');
        return;
    }
    clearPairRequestTimer();
    syncStore.setPairingState('requesting');

    // Wait for the other device to be found before deciding it cannot be
    // reached. Without a broker this is the only way to it, and discovery is
    // not instant.
    if (!(await waitForPairRoute(peerNodeId))) {
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

// Switch between using the broker as a fallback and refusing it outright.
//
// Applied now rather than at the next launch, and to the connection rather
// than only to the routing: a device that goes on holding a broker session
// open has not stopped using the broker, whatever the setting says.
//
// Peers that are not on this network are disconnected on the way in. "Local
// network only" that keeps syncing to a device on the other side of the
// country would be a promise the user cannot check and would be right not to
// believe. They are not suppressed, so switching back brings them straight
// home.
export async function setSyncMode(mode: SyncMode): Promise<void> {
    log.debug(`[sync] setSyncMode(${mode})`);
    await invoke('save_sync_mode', { mode });
    syncStore.setSyncMode(mode);

    if (mode === 'local-only') {
        await invoke('broker_disconnect').catch((e) =>
            console.error('[sync] broker_disconnect failed:', e),
        );
        syncStore.setBrokerStatus('disconnected');
        disconnectPeersOffThisNetwork();
        if (!get(canSignal)) pauseAllReconnects();
        return;
    }

    const brokerUrl = await invoke<string | null>('get_mqtt_broker_url');
    if (!brokerUrl || brokerUrl.trim() === '') {
        log.debug('[sync] no broker configured, nothing to reconnect to');
        return;
    }
    syncStore.setBrokerStatus('connecting');
    try {
        await invoke('broker_connect', { brokerUrl });
    } catch (e) {
        console.error('[sync] Failed to connect to MQTT broker:', e);
        syncStore.setBrokerStatus('error');
    }
}

function disconnectPeersOffThisNetwork(): void {
    const local = get(lanPeerIds);
    for (const peerNodeId of [...sessions.keys()]) {
        if (local.has(peerNodeId)) continue;
        const session = sessions.get(peerNodeId);
        if (!session) continue;
        log.debug(`[sync] [${peerNodeId}] not on this network, disconnecting for local-only`);
        syncStore.removeConnectedPeer(session.roomId);
        teardownSession(peerNodeId);
    }
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

        const mode = await invoke<SyncMode>('get_sync_mode').catch((e) => {
            console.warn('[sync] could not read the sync mode, assuming auto:', e);
            return 'auto' as SyncMode;
        });
        syncStore.setSyncMode(mode);
        log.debug(`[sync] sync mode: ${mode}`);

        // The local network first, because it is the preferred route and
        // because it is the only one that works with no internet.
        await startLocalNetwork();

        // Read before the mode is acted on, so a configured broker is still
        // shown in settings by a device that is currently not using it.
        const mqttBroker = await invoke<string | null>('get_mqtt_broker_url');
        log.debug(`[sync] MQTT broker URL from config: ${mqttBroker || '(none)'}`);
        const hasBroker = !!mqttBroker && mqttBroker.trim() !== '';
        if (hasBroker) syncStore.setBrokerUrl(mqttBroker);

        if (mode === 'local-only') {
            log.debug('[sync] local-network-only, not connecting to the broker');
            syncStore.setBrokerStatus('disconnected');
            await finishInit();
            return;
        }

        if (hasBroker) {
            syncStore.setBrokerStatus('connecting');
            try {
                log.debug(`[sync] Connecting to MQTT broker ${mqttBroker}...`);
                await invoke('broker_connect', { brokerUrl: mqttBroker });
            } catch (e) {
                console.error('[sync] Failed to connect to MQTT broker:', e);
                syncStore.setBrokerStatus('error');
            }
        } else {
            console.warn(
                '[sync] No MQTT broker URL configured, only the local network will be used',
            );
            syncStore.setBrokerStatus('disconnected');
        }

        await finishInit();
    } catch (error) {
        console.error('[sync] Failed to init sync:', error);
        syncStore.setBrokerStatus('error');
    }
}

async function finishInit(): Promise<void> {
    await refreshPairedDevices();

    if (get(canSignal)) {
        void reconnectAllPairedDevices('init');
    }

    log.debug('[sync] initSync() complete, event listeners active');
}

// Start advertising on this network and listening for peers on it.
//
// A failure here is not fatal: discovery can be unavailable for reasons that
// have nothing to do with the app, from a firewall prompt the user has not
// answered to a platform that has no backend for it yet. The broker still
// works, and `canSignal` already accounts for this being off.
async function startLocalNetwork(): Promise<void> {
    try {
        const port = await invoke<number>('lan_start');
        log.debug(`[sync] local network signaling listening on port ${port}`);
        // Seeds the list from whatever discovery already knows, which matters
        // when sync is restarted rather than started.
        syncStore.setLanPeers(await invoke<LanPeer[]>('lan_list_peers'));
    } catch (e) {
        console.warn('[sync] local network sync unavailable:', e);
        syncStore.setLanStatus('error');
    }
}

async function setupEventListeners(): Promise<void> {
    log.debug('[sync] Registering Tauri event listeners');

    const unlistenPairRequest = await listen<{
        from: string;
        user_id: string;
        display_name: string;
        route: SignalingRoute;
    }>('signaling-pair-request-received', (event) => {
        log.debug(
            `[sync] event: pair-request from=${event.payload.from} display_name=${event.payload.display_name} route=${event.payload.route}`,
        );
        syncStore.setPendingPairRequest(event.payload);
    });

    const unlistenPairResponse = await listen<{
        from: string;
        user_id: string;
        display_name: string;
        accepted: boolean;
        route: SignalingRoute;
    }>('signaling-pair-response-received', async (event) => {
        const { from, user_id, display_name, accepted, route } = event.payload;
        log.debug(`[sync] event: pair-response from=${from} accepted=${accepted} route=${route}`);
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
        route: SignalingRoute;
    }>('signaling-offer-received', async (event) => {
        const { from, sdp, room_id, display_name, route } = event.payload;
        log.debug(`[sync] event: offer from=${from} room_id=${room_id} route=${route}`);
        try {
            const { boot, epoch, description } = parseDescPayload(sdp);
            await handleDescription(
                from,
                {
                    boot,
                    epoch,
                    description,
                    roomId: room_id,
                    displayName: display_name,
                },
                route,
            );
        } catch (e) {
            console.error(`[sync] [${from}] bad offer payload:`, e);
        }
    });

    const unlistenAnswer = await listen<{ from: string; sdp: string; route: SignalingRoute }>(
        'signaling-answer-received',
        async (event) => {
            const { from, sdp, route } = event.payload;
            log.debug(`[sync] event: answer from=${from} route=${route}`);
            try {
                const { boot, epoch, description } = parseDescPayload(sdp);
                await handleDescription(from, { boot, epoch, description }, route);
            } catch (e) {
                console.error(`[sync] [${from}] bad answer payload:`, e);
            }
        },
    );

    const unlistenIce = await listen<{ from: string; candidate: string; route: SignalingRoute }>(
        'signaling-ice-candidate-received',
        async (event) => {
            const { from, candidate, route } = event.payload;
            log.debug(`[sync] event: ice-candidate from=${from} route=${route}`);
            try {
                const { boot, epoch, candidate: cand } = parseIcePayload(candidate);
                await handleIceCandidate(from, { boot, epoch, candidate: cand });
            } catch (e) {
                console.error(`[sync] [${from}] bad ICE payload:`, e);
            }
        },
    );

    // Emitted once per run of failed connection attempts, never after a
    // session has been up. `broker_connect` resolves before a single packet is
    // exchanged, so this is the only signal that the broker is unreachable or
    // refusing us.
    const unlistenError = await listen<string>('broker-error', (event) => {
        log.debug(`[sync] event: broker-error -> ${event.payload}`);
        syncStore.setBrokerError(event.payload);
    });

    const unlistenStatus = await listen<string>('broker-status', (event) => {
        const next = event.payload as BrokerStatus;
        const prev = get(brokerStatus);
        log.debug(`[sync] event: broker-status -> ${next} (was ${prev})`);
        syncStore.setBrokerStatus(next);
        if (next === 'connected' && prev !== 'connected') {
            void reconnectAllPairedDevices('broker-connected');
        } else if ((next === 'disconnected' || next === 'error') && !get(canSignal)) {
            // Only when nothing else can reach a peer: with the local network
            // up, the broker dropping is not a reason to stop trying.
            pauseAllReconnects();
        }
    });

    const unlistenLanStatus = await listen<string>('lan-status', (event) => {
        const next = event.payload as LanStatus;
        const prev = get(lanStatus);
        log.debug(`[sync] event: lan-status -> ${next} (was ${prev})`);
        syncStore.setLanStatus(next);
        if (next === 'active' && prev !== 'active') {
            void reconnectAllPairedDevices('lan-active');
        } else if (next !== 'active' && !get(canSignal)) {
            pauseAllReconnects();
        }
    });

    const unlistenLanFound = await listen<LanPeer>('lan-peer-found', (event) => {
        const peer = event.payload;
        log.debug(
            `[sync] event: lan-peer-found ${peer.node_id} at ${peer.addrs.join(', ')}:${peer.port}`,
        );
        syncStore.addLanPeer(peer);
        // A device we are paired with just became reachable without the
        // internet, so try it now rather than at the next backoff tick. A peer
        // already connected through the broker is left alone: the sweep skips
        // it, and tearing down a working connection to move it to a route we
        // have not tried yet would be a poor trade.
        if (get(pairedDevices).some((p) => p.peer_node_id === peer.node_id)) {
            // This event only fires when something about reaching the peer
            // changed, which usually means a new address or a new port after
            // it restarted. A cooldown from the old one says nothing about
            // this one, so it should not hold the new address back.
            void invoke('signaling_clear_route_failure', { peerNodeId: peer.node_id })
                .catch((e) => console.warn(`[sync] [${peer.node_id}] clear cooldown failed:`, e))
                .finally(() => void reconnectAllPairedDevices('lan-peer-found'));
        }
    });

    const unlistenLanLost = await listen<{ node_id: string }>('lan-peer-lost', (event) => {
        log.debug(`[sync] event: lan-peer-lost ${event.payload.node_id}`);
        syncStore.removeLanPeer(event.payload.node_id);
    });

    cleanupFns = [
        unlistenPairRequest,
        unlistenPairResponse,
        unlistenOffer,
        unlistenAnswer,
        unlistenIce,
        unlistenStatus,
        unlistenError,
        unlistenLanStatus,
        unlistenLanFound,
        unlistenLanLost,
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
    void invoke('lan_stop').catch((e) => console.warn('[sync] lan_stop failed:', e));
    syncStore.setLanStatus('off');
}
