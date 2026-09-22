<script lang="ts">
    import { formatLastSync, type DeviceEndpoint, type DevicePair } from '$lib/stores/sync';
    import { nodeIdError } from '$lib/sync/nodeId';

    interface Props {
        endpoints: DeviceEndpoint[];
        pairedDevices: DevicePair[];
        /** Devices whose stored address answered the last probe. */
        reachable: Set<string>;
        onAdd: (nodeId: string, address: string) => Promise<void>;
        onForget: (nodeId: string, host: string, port: number) => Promise<void>;
    }

    let { endpoints, pairedDevices, reachable, onAdd, onForget }: Props = $props();

    let nodeIdInput = $state('');
    let addressInput = $state('');
    let adding = $state(false);
    let error = $state<string | null>(null);

    // Only complain once there is something to complain about, so neither
    // field is red before it has been touched.
    let idError = $derived(nodeIdInput.trim() ? nodeIdError(nodeIdInput) : null);
    let canAdd = $derived(!idError && !!nodeIdInput.trim() && !!addressInput.trim() && !adding);

    // An address is stored against a node id, which is all there is for a
    // device that has not been paired yet. Once it has, its name is the useful
    // thing to show and the id is the thing nobody reads.
    function deviceName(nodeId: string): string {
        return (
            pairedDevices.find((p) => p.peer_node_id === nodeId)?.peer_display_name ??
            `${nodeId.slice(0, 8)}… (not paired yet)`
        );
    }

    async function handleAdd() {
        if (!canAdd) return;
        adding = true;
        error = null;
        try {
            await onAdd(nodeIdInput.trim(), addressInput.trim());
            nodeIdInput = '';
            addressInput = '';
        } catch (e) {
            error = e instanceof Error && e.message ? e.message : String(e);
        } finally {
            adding = false;
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') void handleAdd();
    }
</script>

<section class="section">
    <h2>Devices Somewhere Else</h2>

    <p class="intro">
        A device that is not on this network can still be reached if it has an address that does not
        change, which is what a VPN like Tailscale gives you. Add the other device's address here,
        and add this device's address over there. Oyot does not set up or manage the VPN; it only
        uses the address.
    </p>

    {#if endpoints.length > 0}
        <ul class="address-list">
            {#each endpoints as endpoint (endpoint.peer_node_id + endpoint.host + endpoint.port)}
                <li class="address-item">
                    <div class="address-info">
                        <div class="address-header">
                            <span class="device-name">{deviceName(endpoint.peer_node_id)}</span>
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
                                Has never answered. Check the address, and that Oyot is open on the
                                other device.
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
    {/if}

    <div class="add-form">
        <input
            type="text"
            class="text-input mono"
            placeholder="The other device's Node ID"
            bind:value={nodeIdInput}
            onkeydown={handleKeydown}
            class:invalid={idError}
        />
        <input
            type="text"
            class="text-input"
            placeholder="Its address, e.g. laptop.tailnet-name.ts.net"
            bind:value={addressInput}
            onkeydown={handleKeydown}
        />
        <div class="add-actions">
            <button class="btn-add" onclick={handleAdd} disabled={!canAdd}>
                {adding ? 'Checking…' : 'Add address'}
            </button>
        </div>
        {#if idError}
            <p class="form-status error">{idError}</p>
        {/if}
        {#if error}
            <p class="form-status error">{error}</p>
        {/if}
        <p class="hint">
            The port is optional. Without one, Oyot uses the port it listens on by default.
        </p>
    </div>
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
        margin: 0 0 12px 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-muted);
    }
    .address-list {
        list-style: none;
        margin: 0 0 16px 0;
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
    .device-name {
        font-size: 13px;
        font-weight: 500;
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
    .add-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .text-input {
        padding: 10px 12px;
        font-size: 13px;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
    }
    .text-input.mono {
        font-family: monospace;
    }
    .text-input:focus {
        outline: none;
        border-color: var(--accent-color);
    }
    .text-input.invalid {
        border-color: var(--status-error, #ef4444);
    }
    .add-actions {
        display: flex;
        justify-content: flex-end;
    }
    .btn-add {
        padding: 8px 14px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
    }
    .btn-add:hover {
        opacity: 0.9;
    }
    .btn-add:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
    .form-status {
        font-size: 12px;
        margin: 0;
    }
    .form-status.error {
        color: var(--status-error, #ef4444);
    }
    .hint {
        margin: 4px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
