import * as Y from 'yjs';
import { writable, derived, get } from 'svelte/store';

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
}

export interface ConnectedPeer {
    peer_node_id: string;
    peer_display_name: string;
    room_id: string;
}

export interface PendingPairRequest {
    from: string;
    user_id: string;
    display_name: string;
}

export type SignalingStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type PairingState = 'requesting' | 'declined' | 'timed-out' | null;

function createSyncStore() {
    const { subscribe, set, update } = writable({
        identity: null as UserIdentity | null,
        signalingUrl: null as string | null,
        signalingStatus: 'disconnected' as SignalingStatus,
        pairedDevices: [] as DevicePair[],
        connectedPeers: [] as ConnectedPeer[],
        reconnectingPeers: [] as string[],
        isSyncEnabled: true,
        pendingPairRequest: null as PendingPairRequest | null,
        pairingState: null as PairingState,
    });

    return {
        subscribe,
        set,
        setIdentity: (identity: UserIdentity) => update(s => ({ ...s, identity })),
        setSignalingUrl: (url: string | null) => update(s => ({ ...s, signalingUrl: url })),
        setSignalingStatus: (status: SignalingStatus) => update(s => ({ ...s, signalingStatus: status })),
        setPairedDevices: (devices: DevicePair[]) => update(s => ({ ...s, pairedDevices: devices })),
        setConnectedPeers: (peers: ConnectedPeer[]) => update(s => ({ ...s, connectedPeers: peers })),
        addConnectedPeer: (peer: ConnectedPeer) => update(s => ({
            ...s,
            connectedPeers: [...s.connectedPeers.filter(p => p.room_id !== peer.room_id), peer]
        })),
        removeConnectedPeer: (roomId: string) => update(s => ({
            ...s,
            connectedPeers: s.connectedPeers.filter(p => p.room_id !== roomId)
        })),
        setPeerReconnecting: (peerNodeId: string, reconnecting: boolean) => update(s => ({
            ...s,
            reconnectingPeers: reconnecting
                ? (s.reconnectingPeers.includes(peerNodeId)
                    ? s.reconnectingPeers
                    : [...s.reconnectingPeers, peerNodeId])
                : s.reconnectingPeers.filter(id => id !== peerNodeId),
        })),
        setPendingPairRequest: (req: PendingPairRequest | null) =>
            update(s => ({ ...s, pendingPairRequest: req })),
        setPairingState: (state: PairingState) => update(s => ({ ...s, pairingState: state })),
        setSyncEnabled: (enabled: boolean) => update(s => ({ ...s, isSyncEnabled: enabled })),
    };
}

export const syncStore = createSyncStore();
export const identity = derived(syncStore, $s => $s.identity);
export const signalingStatus = derived(syncStore, $s => $s.signalingStatus);
export const pairedDevices = derived(syncStore, $s => $s.pairedDevices);
export const connectedPeers = derived(syncStore, $s => $s.connectedPeers);
export const connectedPeerIds = derived(connectedPeers, $peers => new Set($peers.map(p => p.peer_node_id)));
export const reconnectingPeerIds = derived(syncStore, $s => new Set($s.reconnectingPeers));
export const pendingPairRequest = derived(syncStore, $s => $s.pendingPairRequest);
export const pairingState = derived(syncStore, $s => $s.pairingState);

export function formatLastSync(timestamp: number | null): string {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}