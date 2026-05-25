import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { syncStore } from '../stores/app';
import { toasts } from './toast';
import type { SyncPeer } from '../types';

export interface SyncState {
    nodeId: string;
    peers: SyncPeer[];
    status: 'synced' | 'syncing' | 'offline';
    isEnabled: boolean;
}

let cleanupFns: Array<() => void> = [];

export async function initializeSync(): Promise<SyncState> {
    try {
        const [nodeId, peers] = await Promise.all([
            invoke<string>('get_node_id'),
            invoke<SyncPeer[]>('get_sync_peers')
        ]);

        syncStore.setNodeId(nodeId);
        syncStore.setPeers(peers);
        syncStore.setEnabled(true);
        syncStore.setStatus('synced');

        const unlistenConnected = listen<string>('peer-connected', (event) => {
            const peerNodeId = event.payload;
            syncStore.markPeerOnline(peerNodeId);
            syncStore.setStatus('synced');
        });

        const unlistenDisconnected = listen<string>('peer-disconnected', () => {
            syncStore.setStatus('offline');
        });

        const unlistenSyncComplete = listen('sync-complete', () => {
            syncStore.setStatus('synced');
        });

        unlistenConnected.then(fn => cleanupFns.push(fn));
        unlistenDisconnected.then(fn => cleanupFns.push(fn));
        unlistenSyncComplete.then(fn => cleanupFns.push(fn));

        return {
            nodeId,
            peers,
            status: 'synced',
            isEnabled: true
        };
    } catch (error) {
        console.error('Failed to initialize sync:', error);
        syncStore.setStatus('offline');
        toasts.error('Failed to initialize sync');
        throw error;
    }
}

export function getSyncCleanup(): () => void {
    return () => {
        cleanupFns.forEach(fn => fn());
        cleanupFns = [];
    };
}

export async function addPeer(nodeId: string, deviceName: string): Promise<void> {
    try {
        await invoke('add_sync_peer', { peerId: nodeId, deviceName });
        toasts.success('Device added successfully');
    } catch (error) {
        console.error('Failed to add peer:', error);
        toasts.error('Failed to add device');
        throw error;
    }
}

export async function removePeer(nodeId: string): Promise<void> {
    try {
        await invoke('remove_sync_peer', { peerId: nodeId });
        syncStore.removePeer(nodeId);
        toasts.success('Device removed');
    } catch (error) {
        console.error('Failed to remove peer:', error);
        toasts.error('Failed to remove device');
        throw error;
    }
}

export async function toggleSyncEnabled(enabled: boolean): Promise<void> {
    try {
        await invoke('set_sync_enabled', { enabled });
        syncStore.setEnabled(enabled);
        toasts.info(`Auto-sync ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
        console.error('Failed to toggle sync:', error);
        toasts.error('Failed to update sync settings');
        throw error;
    }
}

export async function triggerManualSync(): Promise<void> {
    try {
        syncStore.setStatus('syncing');
        await invoke('trigger_sync');
        syncStore.setStatus('synced');
        toasts.success('Sync completed');
    } catch (error) {
        console.error('Failed to trigger sync:', error);
        syncStore.setStatus('offline');
        toasts.error('Failed to sync');
        throw error;
    }
}

export async function getSignalingUrl(): Promise<string | null> {
    try {
        return await invoke<string | null>('get_signaling_url') ?? null;
    } catch {
        return null;
    }
}

export async function saveSignalingUrl(url: string): Promise<void> {
    try {
        await invoke('save_signaling_url', { url });
        toasts.success('Signaling URL saved');
    } catch (error) {
        console.error('Failed to save signaling URL:', error);
        toasts.error('Failed to save signaling URL');
        throw error;
    }
}

export function formatLastSync(timestamp: number | null): string {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
}