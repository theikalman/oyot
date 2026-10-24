<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { canSignal, connectedPeers, aggregateSyncPhase, pairedDevices } from '$lib/stores/sync';
    import { SYNC_TONE_COLORS, syncBadge } from '$lib/sync/syncBadge';
    import Icon from './Icon.svelte';

    // How sync stands, at the foot of the sidebar: one row that says it and
    // opens Devices & sync. It used to be a pill in every page's header and a
    // list of devices in the sidebar, saying the same thing twice.

    interface Props {
        /** Called after it navigates, so a drawer can close. */
        onNavigate?: () => void;
    }

    let { onNavigate }: Props = $props();

    let badge = $derived(
        syncBadge({
            peers: $connectedPeers.length,
            phase: $aggregateSyncPhase,
            reachable: $canSignal,
        }),
    );
    let paired = $derived($pairedDevices.length);
    let detail = $derived(
        paired === 0
            ? 'no devices paired'
            : `${$connectedPeers.length} of ${paired} device${paired === 1 ? '' : 's'} online`,
    );

    function open() {
        void goto(resolve('/settings/sync'));
        onNavigate?.();
    }
</script>

<button
    class="sync-row"
    onclick={open}
    aria-label="Sync: {badge.label}, {detail}. Devices and sync"
>
    <span class="dot" style="background-color: {SYNC_TONE_COLORS[badge.tone]}"></span>
    <span class="text">
        <span class="label">{badge.label}</span>
        <span class="detail"> · {detail}</span>
    </span>
    <Icon name="chevron-right" size={16} />
</button>

<style>
    .sync-row {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 36px;
        padding: 0 8px 0 10px;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-muted);
        font-size: 13px;
        cursor: pointer;
        text-align: left;
    }

    .sync-row:hover {
        background: var(--bg-hover);
    }

    .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .text {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .label {
        color: var(--text-primary);
        font-weight: 550;
    }

    .detail {
        color: var(--text-secondary);
    }
</style>
