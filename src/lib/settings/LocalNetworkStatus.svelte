<script lang="ts">
    import type { LanStatus } from '$lib/stores/sync';

    interface Props {
        lanStatus: LanStatus;
        /** Other Oyot devices currently visible on this network. */
        nearby: number;
        /** The listener is up, but not on the port a stored address assumes. */
        portTaken: boolean;
        /** Devices currently answering at an address stored for them. */
        remoteCount: number;
        /** Whether any address is stored at all, answering or not. */
        anyStoredAddress: boolean;
        onCheckAddresses: () => Promise<void>;
    }

    let { lanStatus, nearby, portTaken, remoteCount, anyStoredAddress, onCheckAddresses }: Props =
        $props();

    // Addresses are retried on a 45 second timer, which is the right cadence
    // for a device that comes and goes and the wrong one for someone who has
    // just fixed a firewall rule and is watching this line. It lives here
    // rather than beside the addresses themselves, because those are spread
    // over the device rows and this asks about all of them at once.
    let checking = $state(false);

    async function handleCheck() {
        checking = true;
        try {
            await onCheckAddresses();
        } finally {
            // Long enough to read as an action having happened. The probe
            // finishes when it finishes, and the status line says so.
            setTimeout(() => (checking = false), 1500);
        }
    }

    // The second route (ADR 0023). Counted the same way as the local one: how
    // many devices are answering, whether or not they are paired.
    let remoteLabel = $derived(
        remoteCount === 0
            ? 'No device is answering at a stored address'
            : `${remoteCount} device${remoteCount === 1 ? '' : 's'} answering at a stored address`,
    );

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
        Oyot syncs directly between your devices, with nothing sent to a server. Devices on the same
        network find each other by themselves. A device somewhere else is reached at an address you
        give it, which is what the section further down is for.
    </p>

    <div class="status-row">
        <span class="status-dot {lanStatus}"></span>
        <span class="status-label">Local network: {lanLabel}</span>
    </div>

    <div class="status-row">
        <span class="status-dot {remoteCount > 0 ? 'active' : 'off'}"></span>
        <span class="status-label">Stored addresses: {remoteLabel}</span>
        {#if anyStoredAddress}
            <button class="check-now" onclick={handleCheck} disabled={checking}>
                {checking ? 'Checking…' : 'Check now'}
            </button>
        {/if}
    </div>

    {#if lanStatus === 'error'}
        <p class="status-detail">
            This device could not advertise itself on the network, so it cannot find anything here.
            A firewall prompt may be waiting to be answered. Devices you have added an address for
            are unaffected.
        </p>
    {/if}

    {#if portTaken}
        <p class="status-detail">
            Another program is using the port Oyot listens on, so it took a different one. Devices
            on this network are told which port to use and are unaffected; a device that only has
            this one's address cannot reach it. Usually this means a second copy of Oyot is already
            running.
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
    .check-now {
        padding: 0;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 12px;
        color: var(--accent-color);
    }
    .check-now:hover {
        text-decoration: underline;
    }
    .check-now:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        text-decoration: none;
    }
    .status-detail {
        margin: 8px 0 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
</style>
