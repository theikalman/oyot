<script lang="ts">
    import type { SyncPeer } from '$lib/types';

    interface Props {
        peers: SyncPeer[];
        formatLastSync: (ts: number | null) => string;
        onRemovePeer: (nodeId: string) => void;
    }

    let { peers, formatLastSync, onRemovePeer }: Props = $props();
</script>

<section class="section">
    <h2>Connected Devices</h2>
    {#if peers.length === 0}
        <p class="empty-state">No devices connected yet.</p>
    {:else}
        <ul class="peer-list">
            {#each peers as peer}
                <li class="peer-item">
                    <div class="peer-info">
                        <div class="peer-header">
                            <span class="peer-name">{peer.device_name}</span>
                            <span class="peer-status {peer.is_online ? 'online' : 'offline'}">
                                {peer.is_online ? 'Online' : 'Offline'}
                            </span>
                        </div>
                        <span class="peer-node-id">{peer.node_id}</span>
                        <span class="peer-last-sync">Last synced: {formatLastSync(peer.last_synchronized)}</span>
                    </div>
                    <button class="btn-danger" onclick={() => onRemovePeer(peer.node_id)}>
                        Remove
                    </button>
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
        flex: 1;
        min-width: 0;
    }

    .peer-name {
        font-weight: 500;
        color: var(--text-primary);
    }

    .peer-node-id {
        font-family: monospace;
        font-size: 11px;
        color: var(--text-muted);
        word-break: break-all;
    }

    .peer-last-sync {
        font-size: 11px;
        color: var(--text-muted);
    }

    .btn-danger {
        padding: 6px 12px;
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
    }

    .btn-danger:hover {
        background: #fef2f2;
    }

    .peer-header {
        display: flex;
        align-items: center;
        gap: 8px;
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

    :global([data-theme="dark"]) .peer-status.online {
        background: #14532d;
        color: #86efac;
    }
</style>