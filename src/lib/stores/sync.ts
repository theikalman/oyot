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

export interface OnlinePeer {
    id: string;
    user_id: string;
    display_name: string;
}

export interface ConnectedPeer {
    peer_node_id: string;
    peer_display_name: string;
    room_id: string;
}

export type SignalingStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

function createSyncStore() {
    const { subscribe, set, update } = writable({
        identity: null as UserIdentity | null,
        signalingUrl: null as string | null,
        signalingStatus: 'disconnected' as SignalingStatus,
        onlinePeers: [] as OnlinePeer[],
        pairedDevices: [] as DevicePair[],
        connectedPeers: [] as ConnectedPeer[],
        isSyncEnabled: true,
        pendingOffer: null as { from: string; sdp: string; room_id: string } | null,
    });

    return {
        subscribe,
        set,
        setIdentity: (identity: UserIdentity) => update(s => ({ ...s, identity })),
        setSignalingUrl: (url: string | null) => update(s => ({ ...s, signalingUrl: url })),
        setSignalingStatus: (status: SignalingStatus) => update(s => ({ ...s, signalingStatus: status })),
        setOnlinePeers: (peers: OnlinePeer[]) => update(s => ({ ...s, onlinePeers: peers })),
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
        setPendingOffer: (offer: { from: string; sdp: string; room_id: string } | null) =>
            update(s => ({ ...s, pendingOffer: offer })),
        setSyncEnabled: (enabled: boolean) => update(s => ({ ...s, isSyncEnabled: enabled })),
        updateOnlinePeer: (peer: OnlinePeer) => update(s => ({
            ...s,
            onlinePeers: [...s.onlinePeers.filter(p => p.id !== peer.id), peer]
        })),
        removeOnlinePeer: (peerId: string) => update(s => ({
            ...s,
            onlinePeers: s.onlinePeers.filter(p => p.id !== peerId)
        })),
    };
}

export const syncStore = createSyncStore();
export const identity = derived(syncStore, $s => $s.identity);
export const signalingStatus = derived(syncStore, $s => $s.signalingStatus);
export const onlinePeers = derived(syncStore, $s => $s.onlinePeers);
export const pairedDevices = derived(syncStore, $s => $s.pairedDevices);
export const connectedPeers = derived(syncStore, $s => $s.connectedPeers);
export const pendingOffer = derived(syncStore, $s => $s.pendingOffer);

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