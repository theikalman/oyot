// The page's side of sync, which Rust runs (ADR 0031).
//
// Rust keeps a connection to every paired device it can reach for the life
// of the process, window or not, and merges what arrives straight into the
// database. The page only shows what is happening and asks for what the user
// does: pairing, disconnecting, reconnecting. What Rust tells it arrives as
// events; what it had already said when the page loaded, it reads once.

import { log } from '$lib/log';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import {
    syncStore,
    pendingPairRequest,
    pairingState,
    lanStatus,
    lanPeerIds,
    addressPeerIds,
    endpointPeerIds,
    pairedDevices,
    type UserIdentity,
    type DevicePair,
    type LanStatus,
    type Peer,
    type PeerSource,
    type PeerState,
    type PendingPairRequest,
} from '../stores/sync';
import { refreshEndpoints, saveEndpoint } from './endpoints';
import { DocumentRepository } from './DocumentRepository';
import type { ManifestEntry } from './protocol';
import { canReachForPairing, unreachableForPairing, type ReachInputs } from './pairReach';

const repo = new DocumentRepository();
let cleanupFns: UnlistenFn[] = [];

export const documentRepository = repo;

// How the listener and discovery came up. Mirrors `NetworkStatus` in
// commands/signaling.rs.
interface NetworkStatus {
    port: number | null;
    on_default_port: boolean;
    discovery_error: string | null;
}

function applyNetworkStatus(status: NetworkStatus): void {
    if (status.port !== null) syncStore.setListener(status.port, status.on_default_port);
    if (status.discovery_error) {
        console.warn('[sync] local network discovery unavailable:', status.discovery_error);
    }
    syncStore.setLanStatus(status.discovery_error ? 'error' : 'active');
}

async function refreshPairedDevices(): Promise<void> {
    syncStore.setPairedDevices(await invoke<DevicePair[]>('list_paired_devices'));
}

function applyPeerState(state: PeerState): void {
    // A device this page has not listed yet was paired a moment ago, on
    // either side, and Rust has recorded it.
    if (!get(pairedDevices).some((p) => p.peer_node_id === state.peerNodeId)) {
        void refreshPairedDevices().then(() => syncStore.applyPeerState(state));
        return;
    }
    syncStore.applyPeerState(state);
}

// The image node view calls this when it renders a reference whose bytes are
// missing here: ask every connected device for them.
export function pullAttachmentFromPeers(hash: string): void {
    void invoke('request_attachment', { hash }).catch((e) =>
        console.warn(`[sync] could not ask for ${hash}:`, e),
    );
}

// --- pairing ---------------------------------------------------------

// How long to wait for the other device to answer a pair request.
//
// Long enough that someone has to walk to the other device and tap Accept,
// short enough that an unanswered request does not look like a hung app.
// Without it the button read "Requesting..." until the app was restarted, and
// the id the user typed had already been cleared from the field, so there was
// nothing to retry with. Rust waits a little longer, so an answer given just
// before this runs out still pairs the two.
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
        await invoke('request_pair', { peerNodeId });
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

// Only the node_id goes back: Rust kept the request it prompted for, and who
// the device said it was comes from that (ADR 0032, decision 5).
export async function respondToPairRequest(accept: boolean): Promise<void> {
    const req = get(pendingPairRequest);
    if (!req) {
        console.warn('[sync] respondToPairRequest() called with no pending request');
        return;
    }
    syncStore.setPendingPairRequest(null);
    try {
        log.debug(`[sync] ${accept ? 'Accepting' : 'Declining'} pair request from ${req.from}`);
        await invoke('answer_pair_request', { peerNodeId: req.from, accept });
    } catch (e) {
        console.error('[sync] Failed to respond to pair request:', e);
    }
}

// --- the connection controls ------------------------------------------

// Stays disconnected until the user reconnects it, across restarts (ADR
// 0032, decision 10).
export async function disconnectPeer(roomId: string): Promise<void> {
    const pair = get(pairedDevices).find((p) => p.room_id === roomId);
    if (!pair) return;
    try {
        await invoke('disconnect_device', { peerNodeId: pair.peer_node_id });
        await refreshPairedDevices();
    } catch (e) {
        console.error(`[sync] could not disconnect ${pair.peer_node_id}:`, e);
    }
}

// Dial now, skipping any backoff, and lift a disconnect. A device that is
// already connected is left alone.
export async function reconnectPeer(peerNodeId: string): Promise<void> {
    try {
        await invoke('reconnect_device', { peerNodeId });
        await refreshPairedDevices();
    } catch (e) {
        console.error(`[sync] could not reconnect ${peerNodeId}:`, e);
    }
}

// --- lifecycle -----------------------------------------------------

// Read how every paired device stands, in full. At load, and when the page
// comes back on screen: a page the system suspended while hidden may have
// missed some of what it was told.
export async function refreshSyncStatus(): Promise<void> {
    for (const state of await invoke<PeerState[]>('get_sync_status')) {
        syncStore.applyPeerState(state);
    }
}

export async function initSync(): Promise<void> {
    log.debug('[sync] initSync() starting...');
    try {
        const identity = await invoke<UserIdentity>('get_identity');
        syncStore.setIdentity(identity);

        // Listening first, so nothing said between the reads below and the
        // listeners going up is missed.
        await setupEventListeners();

        await refreshPairedDevices();
        await refreshEndpoints();
        syncStore.setPeers(await invoke<Peer[]>('list_reachable_peers'));
        await refreshSyncStatus();
        // Null until the listener is up, which `network-started` then says.
        const status = await invoke<NetworkStatus | null>('get_network_status');
        if (status) applyNetworkStatus(status);
        else syncStore.setLanStatus('starting');
        log.debug('[sync] initSync() complete');
    } catch (error) {
        console.error('[sync] Failed to init sync:', error);
        syncStore.setLanStatus('error');
    }
}

async function setupEventListeners(): Promise<void> {
    cleanupFns = await Promise.all([
        listen<NetworkStatus>('network-started', (event) => applyNetworkStatus(event.payload)),

        listen<string>('lan-status', (event) => {
            log.debug(`[sync] event: lan-status -> ${event.payload}`);
            syncStore.setLanStatus(event.payload as LanStatus);
        }),

        listen<Peer>('peer-found', (event) => {
            const peer = event.payload;
            log.debug(`[sync] event: peer-found ${peer.node_id} via ${peer.source}`);
            syncStore.addPeer(peer);
        }),

        listen<{ node_id: string; source: PeerSource }>('peer-lost', (event) => {
            const { node_id, source } = event.payload;
            log.debug(`[sync] event: peer-lost ${node_id} via ${source}`);
            syncStore.removePeer(node_id, source);
        }),

        listen<PeerState>('sync-peer-state', (event) => applyPeerState(event.payload)),

        listen<PendingPairRequest>('signaling-pair-request-received', (event) => {
            log.debug(`[sync] event: pair-request from=${event.payload.from}`);
            syncStore.setPendingPairRequest(event.payload);
        }),

        listen<PendingPairRequest & { accepted: boolean }>(
            'signaling-pair-response-received',
            (event) => {
                const { from, accepted } = event.payload;
                log.debug(`[sync] event: pair-response from=${from} accepted=${accepted}`);
                clearPairRequestTimer();
                if (accepted) {
                    // Rust recorded the pair, and the connection that asked is
                    // now its sync connection.
                    syncStore.setPairingState(null);
                    void refreshPairedDevices();
                } else if (get(pairingState) === 'requesting') {
                    syncStore.setPairingState('declined');
                }
            },
        ),

        listen<ManifestEntry>('sync-doc-created', (event) => repo.peerCreated(event.payload)),

        listen<{ id: string; title: string; titleUpdatedAt: number }>(
            'sync-doc-renamed',
            (event) => {
                const { id, title, titleUpdatedAt } = event.payload;
                repo.peerRenamed(id, title, titleUpdatedAt);
            },
        ),

        listen<{ id: string; pinned: boolean; pinnedUpdatedAt: number }>(
            'sync-doc-pinned',
            (event) => {
                const { id, pinned, pinnedUpdatedAt } = event.payload;
                repo.peerPinned(id, pinned, pinnedUpdatedAt);
            },
        ),

        listen<{ id: string }>('sync-doc-deleted', (event) => repo.peerDeleted(event.payload.id)),

        listen<{ docId: string; update: string }>('sync-doc-merged', (event) => {
            const { docId, update } = event.payload;
            void repo
                .peerMerged(docId, update)
                .catch((e) => console.error(`[sync] could not apply an update to ${docId}:`, e));
        }),
    ]);
}

// The page is going, and sync is not: only what the page listens to stops.
export function shutdownSync(): void {
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    clearPairRequestTimer();
}
