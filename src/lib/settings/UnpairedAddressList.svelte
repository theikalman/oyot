<script lang="ts">
    import { formatLastSync, type DeviceEndpoint, type DevicePair } from '$lib/stores/sync';

    interface Props {
        endpoints: DeviceEndpoint[];
        pairedDevices: DevicePair[];
        /** Devices answering at an address stored for them. */
        reachable: Set<string>;
        onForget: (nodeId: string, host: string, port: number) => Promise<void>;
    }

    let { endpoints, pairedDevices, reachable, onForget }: Props = $props();

    // An address is stored before the pair request goes out, because reaching
    // the device is how the pairing gets made. When that pairing is declined
    // or never answered, the address outlives it, and this is the only place
    // it can be seen or removed. Every other address belongs to a paired
    // device and is shown on that device's row.
    //
    // Normally there are none and the whole section is absent, which is the
    // point: it is a loose end, not a feature.
    let orphans = $derived(
        endpoints.filter((e) => !pairedDevices.some((p) => p.peer_node_id === e.peer_node_id)),
    );
</script>

{#if orphans.length > 0}
    <section class="section">
        <h2>Addresses Without a Device</h2>

        <p class="intro">
            These were added while pairing with a device that did not finish pairing. Pair with it
            again from "Pair a Device" above, leaving the address blank since it is already stored,
            or remove it here.
        </p>

        <ul class="address-list">
            {#each orphans as endpoint (endpoint.peer_node_id + endpoint.host + endpoint.port)}
                <li class="address-item">
                    <div class="address-info">
                        <div class="address-header">
                            <span class="device-id">{endpoint.peer_node_id.slice(0, 12)}…</span>
                            <span
                                class="address-status {reachable.has(endpoint.peer_node_id)
                                    ? 'online'
                                    : 'offline'}"
                            >
                                {reachable.has(endpoint.peer_node_id) ? 'Answering' : 'No answer'}
                            </span>
                        </div>
                        <span class="address-host">{endpoint.host}:{endpoint.port}</span>
                        <span class="address-detail">
                            {#if endpoint.last_ok}
                                Last answered {formatLastSync(endpoint.last_ok)}
                            {:else}
                                Has never answered.
                            {/if}
                        </span>
                    </div>
                    <button
                        class="btn-danger"
                        onclick={() =>
                            onForget(endpoint.peer_node_id, endpoint.host, endpoint.port)}
                    >
                        Remove
                    </button>
                </li>
            {/each}
        </ul>
    </section>
{/if}

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
        margin: 0 0 12px 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-muted);
    }
    .address-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .address-item {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
    }
    .address-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }
    .address-header {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .device-id {
        font-family: monospace;
        font-size: 13px;
        color: var(--text-primary);
    }
    .address-status {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 999px;
    }
    .address-status.online {
        color: var(--status-ok, #22c55e);
        border: 1px solid var(--status-ok, #22c55e);
    }
    .address-status.offline {
        color: var(--text-muted);
        border: 1px solid var(--border-light);
    }
    .address-host {
        font-family: monospace;
        font-size: 12px;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
    }
    .address-detail {
        font-size: 12px;
        color: var(--text-muted);
    }
    .btn-danger {
        padding: 6px 12px;
        background: transparent;
        color: var(--status-error, #ef4444);
        border: 1px solid var(--status-error, #ef4444);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        flex-shrink: 0;
    }
    .btn-danger:hover {
        background: var(--status-error, #ef4444);
        color: white;
    }
</style>
