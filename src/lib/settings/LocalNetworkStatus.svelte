<script lang="ts">
    import type { LanStatus } from '$lib/stores/sync';

    interface Props {
        lanStatus: LanStatus;
        /** Other Oyot devices currently visible on this network. */
        nearby: number;
    }

    let { lanStatus, nearby }: Props = $props();

    // This was a choice between two connection modes until ADR 0022 removed the
    // broker. What is left is the half the user could not otherwise see:
    // whether discovery is working, and whether it is finding anything. The
    // count includes devices that are not paired, because "something is being
    // found" is the useful signal when the question is whether discovery works
    // on this network at all.
    let lanLabel = $derived.by(() => {
        switch (lanStatus) {
            case 'active':
                if (nearby === 0) return 'Searching, no other devices found yet';
                return `Searching, ${nearby} device${nearby === 1 ? '' : 's'} nearby`;
            case 'starting':
                return 'Starting…';
            case 'error':
                return 'Unavailable on this device';
            default:
                return 'Off';
        }
    });
</script>

<section class="section">
    <h2>Sync Connection</h2>

    <p class="intro">
        Oyot syncs directly between your devices when they are on the same network. Nothing is sent
        to a server, and devices that are not on this network do not sync until they are.
    </p>

    <div class="status-row">
        <span class="status-dot {lanStatus}"></span>
        <span class="status-label">Local network: {lanLabel}</span>
    </div>

    {#if lanStatus === 'error'}
        <p class="status-detail">
            This device could not advertise itself on the network, so it cannot sync at all. A
            firewall prompt may be waiting to be answered.
        </p>
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
    .intro {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-muted);
    }
    .status-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 12px;
    }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .status-dot.active {
        background: var(--status-ok, #22c55e);
    }
    .status-dot.starting {
        background: var(--status-pending, #f59e0b);
    }
    .status-dot.off {
        background: var(--status-idle, #9ca3af);
    }
    .status-dot.error {
        background: var(--status-error, #ef4444);
    }
    .status-label {
        font-size: 12px;
        color: var(--text-muted);
    }
    .status-detail {
        margin: 8px 0 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
</style>
