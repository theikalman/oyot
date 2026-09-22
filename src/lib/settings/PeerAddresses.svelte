<script lang="ts">
    import { formatLastSync, type DeviceEndpoint } from '$lib/stores/sync';

    interface Props {
        nodeId: string;
        /** Every address stored for this one device. */
        addresses: DeviceEndpoint[];
        /** Whether one of them answered the last probe. */
        answering: boolean;
        onAdd: (nodeId: string, address: string) => Promise<void>;
        onForget: (nodeId: string, host: string, port: number) => Promise<void>;
    }

    let { nodeId, addresses, answering, onAdd, onForget }: Props = $props();

    // The field is opened rather than always shown. Most devices are on the
    // same network as this one and will never need an address, and a row per
    // device with a permanent text input in it reads as something unfinished.
    let adding = $state(false);
    let addressInput = $state('');
    let saving = $state(false);
    let error = $state<string | null>(null);
    let field = $state<HTMLInputElement | null>(null);

    // Focus explicitly rather than with the `autofocus` attribute, which is
    // only honoured on a page load in some engines and so did nothing for a
    // field that appears on a click.
    $effect(() => {
        if (adding) field?.focus();
    });

    function open() {
        adding = true;
        error = null;
    }

    function cancel() {
        adding = false;
        addressInput = '';
        error = null;
    }

    async function save() {
        const address = addressInput.trim();
        if (!address || saving) return;
        saving = true;
        error = null;
        try {
            await onAdd(nodeId, address);
            cancel();
        } catch (e) {
            error = e instanceof Error && e.message ? e.message : String(e);
        } finally {
            saving = false;
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') void save();
        if (event.key === 'Escape') cancel();
    }

    // What an address is doing, which is three states rather than two. A row
    // that has never answered is usually a typo or a device that was never
    // awake at the same time; one that answered an hour ago is a device that
    // has gone to sleep since. Those want different things done about them.
    function addressState(endpoint: DeviceEndpoint): string {
        if (answering) return 'answering';
        if (endpoint.last_ok) return `last answered ${formatLastSync(endpoint.last_ok)}`;
        return 'has never answered';
    }
</script>

{#each addresses as endpoint (endpoint.host + endpoint.port)}
    <span class="address-row">
        <span class="address" class:answering>{endpoint.host}:{endpoint.port}</span>
        <span class="address-state">{addressState(endpoint)}</span>
        <button
            class="link-button danger"
            onclick={() => onForget(nodeId, endpoint.host, endpoint.port)}
        >
            Remove
        </button>
    </span>
{/each}

{#if adding}
    <span class="add-row">
        <input
            type="text"
            class="address-input"
            placeholder="e.g. laptop.tailnet-name.ts.net"
            aria-label="Address for this device"
            bind:this={field}
            bind:value={addressInput}
            onkeydown={handleKeydown}
        />
        <button class="link-button" onclick={save} disabled={!addressInput.trim() || saving}>
            {saving ? 'Checking…' : 'Save'}
        </button>
        <button class="link-button" onclick={cancel}>Cancel</button>
    </span>
    {#if error}
        <span class="add-error">{error}</span>
    {:else}
        <span class="add-hint">
            A host name or address that does not change, such as a Tailscale one. The port is
            optional.
        </span>
    {/if}
{:else}
    <button class="link-button add" onclick={open}>
        {addresses.length === 0 ? 'Add an address' : 'Add another address'}
    </button>
{/if}

<style>
    .address-row {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 8px;
        font-size: 12px;
    }
    .address {
        font-family: monospace;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
    }
    .address.answering {
        color: var(--status-ok, #22c55e);
    }
    .address-state {
        color: var(--text-muted);
    }
    .add-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 4px;
    }
    .address-input {
        /* A whole line of its own, so Save and Cancel wrap underneath rather
           than ending up alongside this device's Reconnect and Remove. */
        flex: 1 1 100%;
        padding: 6px 8px;
        font-size: 12px;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 4px;
    }
    .address-input:focus {
        outline: none;
        border-color: var(--accent-color);
    }
    .add-hint,
    .add-error {
        font-size: 12px;
        line-height: 1.5;
        margin-top: 2px;
    }
    .add-hint {
        color: var(--text-muted);
    }
    .add-error {
        color: var(--status-error, #ef4444);
    }
    .link-button {
        padding: 0;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 12px;
        color: var(--accent-color);
    }
    .link-button:hover {
        text-decoration: underline;
    }
    .link-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        text-decoration: none;
    }
    .link-button.danger {
        color: var(--status-error, #ef4444);
    }
    .link-button.add {
        align-self: flex-start;
        margin-top: 2px;
    }
</style>
