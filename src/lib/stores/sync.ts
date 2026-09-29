import { writable, derived } from 'svelte/store';

export interface UserIdentity {
    user_id: string;
    node_id: string;
    display_name: string;
}

export interface DevicePair {
    peer_node_id: string;
    peer_display_name: string;
    room_id: string;
    last_synchronized: number | null;
    /** The user disconnected it, and it stays so until they reconnect it. */
    disconnected?: boolean;
}

export interface ConnectedPeer {
    peer_node_id: string;
    peer_display_name: string;
    room_id: string;
}

// How a peer was found. `mdns` announced itself on this network; `address`
// answered a probe at an address the user stored for it (ADR 0023).
export type PeerSource = 'mdns' | 'address';

// A device this one can reach, as `network::peers` reports it. The same device
// can appear twice, once per source, when both routes are up.
export interface Peer {
    node_id: string;
    source: PeerSource;
    boot_id: string | null;
    addrs: string[];
    /** The host as the user wrote it, for an address peer. Null for mDNS. */
    host: string | null;
    port: number;
    seen_at: number;
}

// An address the user stored for a device, as `endpoints.rs` holds it. A row
// is a guess until a probe answers it; `last_ok` is the difference between
// "not connected right now" and "this has never worked" (ADR 0023).
export interface DeviceEndpoint {
    peer_node_id: string;
    host: string;
    port: number;
    added_at: number;
    last_ok: number | null;
}

export interface PendingPairRequest {
    from: string;
    user_id: string;
    display_name: string;
}

// Whether this device is discoverable on, and discovering peers on, the local
// network. Since ADR 0022 this is the whole of "can this device sync": there
// is no second transport left for `canSignal` to consider.
export type LanStatus = 'off' | 'starting' | 'active' | 'error';

export type PairingState = 'requesting' | 'declined' | 'timed-out' | null;

// Per-room document-sync progress, as the sync engine reports it.
export type RoomSyncPhase =
    'idle' | 'connecting' | 'reconciling' | 'transferring' | 'synced' | 'error';

// One paired device's connection, as the sync engine reports it (ADR 0031,
// decision 9). Mirrors `PeerState` in sync/events.rs.
export interface PeerState {
    peerNodeId: string;
    displayName: string;
    roomId: string;
    connected: boolean;
    /** A connection is being made, or will be retried. */
    reconnecting: boolean;
    phase: RoomSyncPhase;
    pending: number;
    total: number;
    lastSyncedAt: number | null;
}

export interface RoomSync {
    phase: RoomSyncPhase;
    pending: number;
    total: number;
    lastSyncedAt: number | null;
}

function createSyncStore() {
    const { subscribe, set, update } = writable({
        identity: null as UserIdentity | null,
        lanStatus: 'off' as LanStatus,
        // The port the signaling listener came up on, and whether it is the
        // one a peer holding only a stored address assumes (ADR 0023).
        listenPort: null as number | null,
        onDefaultPort: false,
        peers: [] as Peer[],
        endpoints: [] as DeviceEndpoint[],
        pairedDevices: [] as DevicePair[],
        connectedPeers: [] as ConnectedPeer[],
        reconnectingPeers: [] as string[],
        roomSync: {} as Record<string, RoomSync>,
        isSyncEnabled: true,
        pendingPairRequest: null as PendingPairRequest | null,
        pairingState: null as PairingState,
    });

    return {
        subscribe,
        set,
        setIdentity: (identity: UserIdentity) => update((s) => ({ ...s, identity })),
        setLanStatus: (status: LanStatus) =>
            update((s) => ({
                ...s,
                lanStatus: status,
                // Nothing found on this network is reachable once discovery
                // stops, and a list left behind would go on claiming
                // otherwise. Peers found at a stored address stay: that route
                // is a different one and it is still up.
                peers: status === 'active' ? s.peers : s.peers.filter((p) => p.source !== 'mdns'),
            })),
        setListener: (listenPort: number, onDefaultPort: boolean) =>
            update((s) => ({ ...s, listenPort, onDefaultPort })),
        setPeers: (peers: Peer[]) => update((s) => ({ ...s, peers })),
        setEndpoints: (endpoints: DeviceEndpoint[]) => update((s) => ({ ...s, endpoints })),
        addPeer: (peer: Peer) =>
            update((s) => ({
                ...s,
                peers: [
                    ...s.peers.filter(
                        (p) => !(p.node_id === peer.node_id && p.source === peer.source),
                    ),
                    peer,
                ],
            })),
        removePeer: (nodeId: string, source: PeerSource) =>
            update((s) => ({
                ...s,
                peers: s.peers.filter((p) => !(p.node_id === nodeId && p.source === source)),
            })),
        setPairedDevices: (devices: DevicePair[]) =>
            update((s) => ({ ...s, pairedDevices: devices })),
        // Everything the engine says about one device, in one update: whether
        // it is connected or being tried, how far along its exchange is, and
        // when it last finished one.
        applyPeerState: (p: PeerState) =>
            update((s) => {
                const listed = s.connectedPeers.some((c) => c.room_id === p.roomId);
                const connectedPeers =
                    p.connected === listed
                        ? s.connectedPeers
                        : p.connected
                          ? [
                                ...s.connectedPeers,
                                {
                                    peer_node_id: p.peerNodeId,
                                    peer_display_name: p.displayName,
                                    room_id: p.roomId,
                                },
                            ]
                          : s.connectedPeers.filter((c) => c.room_id !== p.roomId);
                const trying = p.reconnecting && !p.connected;
                const reconnectingPeers =
                    trying === s.reconnectingPeers.includes(p.peerNodeId)
                        ? s.reconnectingPeers
                        : trying
                          ? [...s.reconnectingPeers, p.peerNodeId]
                          : s.reconnectingPeers.filter((id) => id !== p.peerNodeId);
                return {
                    ...s,
                    connectedPeers,
                    reconnectingPeers,
                    roomSync: {
                        ...s.roomSync,
                        [p.roomId]: {
                            phase: p.phase,
                            pending: p.pending,
                            total: p.total,
                            lastSyncedAt: p.lastSyncedAt,
                        },
                    },
                    pairedDevices: s.pairedDevices.map((d) =>
                        d.peer_node_id === p.peerNodeId &&
                        p.lastSyncedAt !== null &&
                        d.last_synchronized !== p.lastSyncedAt
                            ? { ...d, last_synchronized: p.lastSyncedAt }
                            : d,
                    ),
                };
            }),
        setPendingPairRequest: (req: PendingPairRequest | null) =>
            update((s) => ({ ...s, pendingPairRequest: req })),
        setPairingState: (state: PairingState) => update((s) => ({ ...s, pairingState: state })),
        setSyncEnabled: (enabled: boolean) => update((s) => ({ ...s, isSyncEnabled: enabled })),
    };
}

export const syncStore = createSyncStore();
export const identity = derived(syncStore, ($s) => $s.identity);
export const lanStatus = derived(syncStore, ($s) => $s.lanStatus);
export const peers = derived(syncStore, ($s) => $s.peers);

// True only once the listener has actually started and did not get the port a
// device holding only our address assumes. Before it starts there is nothing
// to report, and reporting it then would put a warning on a healthy app every
// time it launched.
export const listeningOnAnotherPort = derived(
    syncStore,
    ($s) => $s.listenPort !== null && !$s.onDefaultPort,
);

// Only the ones on this network. The pairing copy and the "nearby" count mean
// this literally, so they must not count a device reached over a VPN.
export const lanPeers = derived(syncStore, ($s) => $s.peers.filter((p) => p.source === 'mdns'));
export const lanPeerIds = derived(lanPeers, ($p) => new Set($p.map((peer) => peer.node_id)));

// Reachable at a stored address: an address that has answered a probe, which
// is the only evidence there is that one works.
export const addressPeerIds = derived(
    syncStore,
    ($s) => new Set($s.peers.filter((p) => p.source === 'address').map((p) => p.node_id)),
);

export const deviceEndpoints = derived(syncStore, ($s) => $s.endpoints);
export const endpointPeerIds = derived(
    syncStore,
    ($s) => new Set($s.endpoints.map((e) => e.peer_node_id)),
);

// Whether there is any way to reach a peer right now.
//
// ADR 0018 introduced this so that no single transport could define whether
// the app was able to sync at all. ADR 0022 left one transport and it collapsed
// onto discovery being up. ADR 0023 puts the second route back, and this is the
// seam it was kept for: a device with no mDNS at all still syncs with whatever
// has answered at a stored address.
export const canSignal = derived(
    syncStore,
    ($s) => $s.lanStatus === 'active' || $s.peers.some((p) => p.source === 'address'),
);
export const pairedDevices = derived(syncStore, ($s) => $s.pairedDevices);
export const connectedPeers = derived(syncStore, ($s) => $s.connectedPeers);
export const connectedPeerIds = derived(
    connectedPeers,
    ($peers) => new Set($peers.map((p) => p.peer_node_id)),
);
export const reconnectingPeerIds = derived(syncStore, ($s) => new Set($s.reconnectingPeers));
export const pendingPairRequest = derived(syncStore, ($s) => $s.pendingPairRequest);
export const pairingState = derived(syncStore, ($s) => $s.pairingState);
export const roomSync = derived(syncStore, ($s) => $s.roomSync);

// Worst-case sync phase across currently-connected rooms, for the global badge.
export const aggregateSyncPhase = derived(syncStore, ($s): RoomSyncPhase => {
    if ($s.connectedPeers.length === 0) return 'idle';
    const active = $s.connectedPeers.map((p) => $s.roomSync[p.room_id]?.phase ?? 'connecting');
    const order: RoomSyncPhase[] = [
        'error',
        'connecting',
        'idle',
        'reconciling',
        'transferring',
        'synced',
    ];
    return order.find((p) => active.includes(p)) ?? 'synced';
});

export function formatLastSync(timestamp: number | null, now: number = Date.now()): string {
    if (!timestamp) return 'Never';
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}
