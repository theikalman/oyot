<script lang="ts">
    import { onMount } from 'svelte';
    import type { PairingState } from '$lib/stores/sync';
    import { nodeIdError } from '$lib/sync/nodeId';
    import { clearsPairField } from '$lib/sync/pairingField';

    interface Props {
        pairingState: PairingState;
        /**
         * Why nothing is reachable from here yet, when nothing is. The form
         * stays usable anyway: a device with no local discovery at all is
         * precisely the one that needs an address typed into it, and hiding
         * the only field that takes one would be a trap.
         */
        noRouteNote?: string | null;
        onPair: (nodeId: string, address: string) => void;
    }

    let { pairingState, noRouteNote = null, onPair }: Props = $props();

    let nodeIdInput = $state('');
    // Where to find the other device, when it is not on this network. Typed
    // here rather than in its own section so that the device's id is typed
    // once, which is the whole flow: one id, one address, one button.
    let addressInput = $state('');
    let isMobile = $state(false);
    let scanError = $state<string | null>(null);

    // Only complain once there is something to complain about, so the field is
    // not red before it has been touched.
    let validationError = $derived(nodeIdInput.trim() ? nodeIdError(nodeIdInput) : null);
    let canPair = $derived(!validationError && pairingState !== 'requesting');

    onMount(async () => {
        try {
            const { platform } = await import('@tauri-apps/plugin-os');
            const p = platform();
            isMobile = p === 'android' || p === 'ios';
        } catch (e) {
            console.warn(
                '[PairDeviceForm] Platform detection unavailable, hiding QR scan button:',
                e,
            );
            isMobile = false;
        }
    });

    function handlePair() {
        const trimmed = nodeIdInput.trim();
        if (nodeIdError(trimmed)) return;
        onPair(trimmed, addressInput.trim());
    }

    // Clear the field when a pairing has actually gone through. The rule, and
    // why it is a rule rather than a condition written out here, is in
    // sync/pairingField.ts.
    //
    // `previousState` is deliberately not $state: it is written from inside
    // the effect, and a tracked write would make the effect re-run itself.
    // Nothing reads `nodeIdInput` here either, so typing does not re-run it.
    let previousState: PairingState = null;
    $effect(() => {
        if (clearsPairField(previousState, pairingState)) {
            nodeIdInput = '';
            addressInput = '';
        }
        previousState = pairingState;
    });

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') handlePair();
    }

    // Scanning fills the same input field as typing rather than pairing immediately -
    // both paths land on the same behavior, letting the user review/edit before pairing.
    async function handleScan() {
        scanError = null;
        try {
            const scanner = await import('@tauri-apps/plugin-barcode-scanner');
            let permission = await scanner.checkPermissions();
            if (permission !== 'granted') {
                permission = await scanner.requestPermissions();
            }
            if (permission !== 'granted') {
                scanError = 'Camera permission denied';
                return;
            }
            const result = await scanner.scan({
                windowed: false,
                formats: [scanner.Format.QRCode],
            });
            if (result?.content) {
                nodeIdInput = result.content;
            }
        } catch (e) {
            console.error('[PairDeviceForm] QR scan failed:', e);
            scanError = 'Could not scan QR code';
        }
    }
</script>

<section class="section">
    <h2>Pair a Device</h2>
    <div class="pair-form">
        <input
            type="text"
            class="node-id-input"
            placeholder="Paste or type the other device's Node ID"
            bind:value={nodeIdInput}
            onkeydown={handleKeydown}
            class:invalid={validationError}
        />
        <input
            type="text"
            class="address-input"
            placeholder="Its address, if it is not on this network (optional)"
            bind:value={addressInput}
            onkeydown={handleKeydown}
        />
        <div class="pair-actions">
            {#if isMobile}
                <button class="btn-scan" onclick={handleScan}>Scan QR</button>
            {/if}
            <button class="btn-pair" onclick={handlePair} disabled={!canPair}>
                {pairingState === 'requesting' ? 'Requesting...' : 'Pair'}
            </button>
        </div>
        {#if validationError}
            <p class="pair-status error">{validationError}</p>
        {/if}
        {#if pairingState === 'declined'}
            <p class="pair-status error">The other device declined the pairing request.</p>
        {/if}
        {#if pairingState === 'timed-out'}
            <p class="pair-status error">
                No answer from that device. Check it is running, and either on the same network as
                this one or reachable at the address you gave, then try again.
            </p>
        {/if}
        {#if scanError}
            <p class="pair-status error">{scanError}</p>
        {/if}
        {#if noRouteNote}
            <p class="pair-status note">{noRouteNote}</p>
        {/if}
        <p class="hint">
            Get the Node ID from the other device's "My Device" card above (copy/paste, or scan its
            QR code). Devices on the same network find each other, so leave the address empty unless
            the other device is somewhere else; then give it a host name or address that does not
            change, such as a Tailscale one.
        </p>
    </div>
</section>

<style>
    .section {
        margin-bottom: 32px;
    }
    .node-id-input.invalid {
        border-color: var(--status-error);
    }
    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .pair-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .node-id-input {
        padding: 10px 12px;
        font-family: monospace;
        font-size: 13px;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
    }
    .node-id-input:focus,
    .address-input:focus {
        outline: none;
        border-color: var(--accent-color);
    }
    .address-input {
        padding: 10px 12px;
        font-size: 13px;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
    }
    .pair-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }
    .btn-scan {
        padding: 8px 14px;
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-light);
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
    }
    .btn-scan:hover {
        background: var(--bg-hover);
    }
    .btn-pair {
        padding: 8px 14px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
    }
    .btn-pair:hover {
        opacity: 0.9;
    }
    .btn-pair:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .pair-status {
        font-size: 12px;
        margin: 0;
    }
    .pair-status.error {
        color: #ef4444;
    }
    .pair-status.note {
        color: var(--text-secondary);
        line-height: 1.5;
    }
    .hint {
        margin: 4px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
