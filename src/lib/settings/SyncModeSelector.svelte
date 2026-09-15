<script lang="ts">
    import type { LanStatus, SyncMode } from '$lib/stores/sync';

    interface Props {
        mode: SyncMode;
        lanStatus: LanStatus;
        /** Other Oyot devices currently visible on this network. */
        nearby: number;
        busy: boolean;
        onChange: (mode: SyncMode) => void;
    }

    let { mode, lanStatus, nearby, busy, onChange }: Props = $props();

    // What the local network is doing, which is the part of this choice the
    // user cannot otherwise see. The count includes devices that are not
    // paired: "something is being found" is the useful signal when the
    // question is whether discovery works on this network at all.
    let lanLabel = $derived.by(() => {
        switch (lanStatus) {
            case 'active':
                if (nearby === 0) return 'On, no other devices found yet';
                return `On, ${nearby} device${nearby === 1 ? '' : 's'} nearby`;
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

    <div class="modes" role="radiogroup" aria-label="Sync connection">
        <label class="mode" class:selected={mode === 'auto'}>
            <input
                type="radio"
                name="sync-mode"
                value="auto"
                checked={mode === 'auto'}
                disabled={busy}
                onchange={() => onChange('auto')}
            />
            <span class="mode-body">
                <span class="mode-title">Automatic</span>
                <span class="mode-note">
                    Reach a device over this network when it is on it, and through the broker when
                    it is not.
                </span>
            </span>
        </label>

        <label class="mode" class:selected={mode === 'local-only'}>
            <input
                type="radio"
                name="sync-mode"
                value="local-only"
                checked={mode === 'local-only'}
                disabled={busy}
                onchange={() => onChange('local-only')}
            />
            <span class="mode-body">
                <span class="mode-title">Local network only</span>
                <span class="mode-note">
                    Never contact the broker. Devices that are not on this network stop syncing
                    until they are, or until this is set back to Automatic.
                </span>
            </span>
        </label>
    </div>

    <div class="status-row">
        <span class="status-dot {lanStatus}"></span>
        <span class="status-label">Local network: {lanLabel}</span>
    </div>

    {#if lanStatus === 'error'}
        <p class="status-detail">
            This device could not advertise itself on the network. A firewall prompt may be waiting
            to be answered. Syncing still works through the broker.
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
    .modes {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .mode {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 16px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        background: var(--bg-primary);
        cursor: pointer;
    }
    .mode:hover {
        background: var(--bg-hover);
    }
    .mode.selected {
        border-color: var(--accent-color);
        background: var(--bg-secondary);
    }
    .mode input {
        margin: 2px 0 0 0;
        accent-color: var(--accent-color);
    }
    .mode-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }
    .mode-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
    }
    .mode-note {
        font-size: 12px;
        line-height: 1.5;
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
