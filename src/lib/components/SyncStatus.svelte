<script lang="ts">
    import { syncStore, syncStatus, syncPeers, type SyncStatus } from '../stores/app';
    import { goto } from '$app/navigation';

    let status = $derived($syncStatus);
    let peers = $derived($syncPeers);

    let onlinePeers = $derived(peers.filter(p => p.is_online).length);

    function getStatusColor(currentStatus: SyncStatus): string {
        switch (currentStatus) {
            case 'synced': return 'var(--status-synced, #22c55e)';
            case 'syncing': return 'var(--status-syncing, #eab308)';
            case 'offline': return 'var(--status-offline, #9ca3af)';
            default: return 'var(--status-offline, #9ca3af)';
        }
    }

    function getStatusLabel(currentStatus: SyncStatus): string {
        switch (currentStatus) {
            case 'synced': return 'Synced';
            case 'syncing': return 'Syncing...';
            case 'offline': return 'Offline';
            default: return 'Unknown';
        }
    }

    async function openSettings() {
        await goto('/settings');
    }
</script>

<button class="sync-status" onclick={openSettings} title="Sync settings">
    <span class="status-dot" style="background-color: {getStatusColor(status)}"></span>
    <span class="status-label">{getStatusLabel(status)}</span>
    {#if onlinePeers > 0}
        <span class="peer-count">{onlinePeers} device{onlinePeers !== 1 ? 's' : ''}</span>
    {/if}
</button>

<style>
    .sync-status {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-light);
        border-radius: 16px;
        cursor: pointer;
        font-size: 12px;
        color: var(--text-secondary);
        transition: background-color 0.2s, border-color 0.2s;
    }

    .sync-status:hover {
        background: var(--bg-hover);
        border-color: var(--border-color);
    }

    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .status-label {
        font-weight: 500;
    }

    .peer-count {
        color: var(--text-muted);
    }
</style>