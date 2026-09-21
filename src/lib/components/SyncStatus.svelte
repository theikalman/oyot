<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { brokerStatus, canSignal, connectedPeers, aggregateSyncPhase } from '$lib/stores/sync';
    import { syncBadge, type SyncTone } from '$lib/sync/syncBadge';

    let broker = $derived($brokerStatus);
    let reachable = $derived($canSignal);
    let peers = $derived($connectedPeers);
    let phase = $derived($aggregateSyncPhase);

    // The rule, and the bug it was extracted for, are in sync/syncBadge.ts.
    let badge = $derived(syncBadge({ peers: peers.length, phase, broker, reachable }));
    let tone = $derived(badge.tone);
    let label = $derived(badge.label);

    function color(t: SyncTone): string {
        switch (t) {
            case 'synced':
                return 'var(--status-synced, #22c55e)';
            case 'syncing':
                return 'var(--status-syncing, #eab308)';
            case 'error':
                return 'var(--status-error, #ef4444)';
            default:
                return 'var(--status-offline, #9ca3af)';
        }
    }

    function openSettings() {
        goto(resolve('/settings/sync'));
    }
</script>

<button class="sync-status" onclick={openSettings} title="Sync settings">
    <span class="status-dot" style="background-color: {color(tone)}"></span>
    <span class="status-label">{label}</span>
    {#if peers.length > 0}
        <span class="peer-count">{peers.length} device{peers.length !== 1 ? 's' : ''}</span>
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
        transition:
            background-color 0.2s,
            border-color 0.2s;
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
