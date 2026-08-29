<script lang="ts">
    import type { ConnectedPeer } from '$lib/stores/sync';
    import { formatLastSync, reconnectingPeerIds, roomSync } from '$lib/stores/sync';

    interface Props {
        pairedDevices: Array<{
            peer_node_id: string;
            peer_display_name: string;
            room_id: string;
            last_synchronized: number | null;
        }>;
        connectedPeers: ConnectedPeer[];
        onDisconnect: (roomId: string) => void;
        onRemove: (peerNodeId: string) => void;
    }

    let { pairedDevices, connectedPeers, onDisconnect, onRemove }: Props = $props();

    function isConnected(roomId: string): boolean {
        return connectedPeers.some(p => p.room_id === roomId);
    }

    // The app reconnects paired devices automatically (on startup, when signaling
    // recovers, and with backoff after a drop), so there is no manual reconnect
    // action - just a live hint while an attempt is in flight.
    function peerStatus(pair: { peer_node_id: string; room_id: string }): 'connected' | 'connecting' | 'offline' {
        if (isConnected(pair.room_id)) return 'connected';
        if ($reconnectingPeerIds.has(pair.peer_node_id)) return 'connecting';
        return 'offline';
    }

    // Fine-grained label for a connected peer, from the document-sync phase.
    function syncLabel(pair: { room_id: string; last_synchronized: number | null }): string {
        const rs = $roomSync[pair.room_id];
        if (!rs) return 'Connected';
        switch (rs.phase) {
            case 'reconciling':
                return 'Syncing…';
            case 'transferring':
                return rs.total > 0 ? `Syncing ${rs.total - rs.pending}/${rs.total}…` : 'Syncing…';
            case 'synced': {
                const at = rs.lastSyncedAt ?? pair.last_synchronized;
                return at ? `Synced · ${formatLastSync(at)}` : 'Synced';
            }
            case 'error':
                return 'Sync error · retrying';
            default:
                return 'Connected';
        }
    }
</script>

<section class="section">
    <h2>Paired Devices</h2>
    {#if pairedDevices.length === 0}
        <p class="empty-state">No paired devices yet. Scan a QR code or enter a Node ID to pair.</p>
    {:else}
        <ul class="peer-list">
            {#each pairedDevices as pair}
                {@const pstatus = peerStatus(pair)}
                <li class="peer-item">
                    <div class="peer-info">
                        <div class="peer-header">
                            <span class="peer-icon">📱</span>
                            <span class="peer-name">{pair.peer_display_name}</span>
                            <span class="peer-status {pstatus === 'connected' ? 'online' : pstatus}">
                                {pstatus === 'connected' ? 'Connected' : pstatus === 'connecting' ? 'Connecting…' : 'Offline'}
                            </span>
                        </div>
                        <span class="peer-id">{pair.peer_node_id}</span>
                        {#if pstatus === 'connected'}
                            <span class="peer-sync">{syncLabel(pair)}</span>
                        {:else if pair.last_synchronized}
                            <span class="peer-sync">Last sync: {formatLastSync(pair.last_synchronized)}</span>
                        {/if}
                    </div>
                    <div class="peer-actions">
                        {#if pstatus === 'connected'}
                            <button class="btn-danger" onclick={() => onDisconnect(pair.room_id)}>
                                Disconnect
                            </button>
                        {:else}
                            <button class="btn-danger" onclick={() => onRemove(pair.peer_node_id)}>
                                Remove
                            </button>
                        {/if}
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</section>

<style>
    .section {
        margin-bottom: 32px;
    }
    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .empty-state {
        color: var(--text-muted);
        font-size: 14px;
    }
    .peer-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }
    .peer-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        margin-bottom: 8px;
        background: var(--bg-primary);
    }
    .peer-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
    }
    .peer-header {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .peer-icon {
        font-size: 16px;
    }
    .peer-name {
        font-weight: 500;
        color: var(--text-primary);
    }
    .peer-status {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        font-weight: 500;
    }
    .peer-status.online {
        background: #dcfce7;
        color: #166534;
    }
    .peer-status.offline {
        background: var(--bg-hover);
        color: var(--text-muted);
    }
    .peer-status.connecting {
        background: #fef3c7;
        color: #92400e;
    }
    :global([data-theme="dark"]) .peer-status.online {
        background: #14532d;
        color: #86efac;
    }
    :global([data-theme="dark"]) .peer-status.connecting {
        background: #451a03;
        color: #fcd34d;
    }
    .peer-id {
        font-family: monospace;
        font-size: 10px;
        color: var(--text-muted);
        word-break: break-all;
    }
    .peer-sync {
        font-size: 10px;
        color: var(--text-muted);
    }
    .peer-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }
    .btn-danger {
        padding: 6px 12px;
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }
    .btn-danger:hover {
        background: #fef2f2;
    }
</style>