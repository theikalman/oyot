<script lang="ts">
    import { onMount } from 'svelte';
    import type { PairingState } from '$lib/stores/sync';
    import { nodeIdError } from '$lib/sync/nodeId';
    import { clearsPairField } from '$lib/sync/pairingField';
    import {
        addressFor,
        canSubmitPair,
        pairMethodWarning,
        type PairAttempt,
        type PairMethod,
    } from '$lib/sync/pairMethod';

    interface Props {
        pairingState: PairingState;
        /** Whether this device is searching the network it is on. */
        discovering: boolean;
        onPair: (nodeId: string, address: string) => void;
    }

    let { pairingState, discovering, onPair }: Props = $props();

    // Which way the other device is to be reached. Asked first, because it
    // decides what else is worth showing: the two routes need different things
    // typed, and offering both at once left "no address" ambiguous between
    // "it is on this network" and "I have not filled that in yet".
    //
    // Always starts on the local network rather than following whether
    // discovery happens to be up. Discovery is off for the first moment after
    // launch, and a form that had already decided the answer by the time it
    // was looked at would be worse than one that is simply predictable.
    let method = $state<PairMethod>('local');

    let nodeIdInput = $state('');
    // Where to find the other device, when it is not on this network. Typed
    // here rather than in its own section so that the device's id is typed
    // once, which is the whole flow: one id, one address, one button.
    let addressInput = $state('');
    let isMobile = $state(false);
    let scanError = $state<string | null>(null);

    let attempt = $derived<PairAttempt>({
        method,
        nodeId: nodeIdInput,
        address: addressInput,
        requesting: pairingState === 'requesting',
    });

    // Only complain once there is something to complain about, so the field is
    // not red before it has been touched.
    let validationError = $derived(nodeIdInput.trim() ? nodeIdError(nodeIdInput) : null);
    let canPair = $derived(canSubmitPair(attempt));
    let methodWarning = $derived(pairMethodWarning(method, discovering));

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
        if (!canPair) return;
        onPair(nodeIdInput.trim(), addressFor(attempt));
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
        <fieldset class="method-choice">
            <legend class="method-legend">Where is the other device?</legend>
            <label class="method-option" class:selected={method === 'local'}>
                <input
                    type="radio"
                    name="pair-method"
                    value="local"
                    aria-label="On this network"
                    bind:group={method}
                />
                <span class="method-title">On this network</span>
                <span class="method-detail">Both devices on the same wifi</span>
            </label>
            <label class="method-option" class:selected={method === 'address'}>
                <input
                    type="radio"
                    name="pair-method"
                    value="address"
                    aria-label="Somewhere else"
                    bind:group={method}
                />
                <span class="method-title">Somewhere else</span>
                <span class="method-detail">Reached at an address, over a VPN</span>
            </label>
        </fieldset>

        <input
            type="text"
            class="node-id-input"
            placeholder="Paste or type the other device's Node ID"
            bind:value={nodeIdInput}
            onkeydown={handleKeydown}
            class:invalid={validationError}
        />
        {#if method === 'address'}
            <input
                type="text"
                class="address-input"
                placeholder="Its address, e.g. laptop.tailnet-name.ts.net"
                bind:value={addressInput}
                onkeydown={handleKeydown}
            />
        {/if}
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
        {#if methodWarning}
            <p class="pair-status note">{methodWarning}</p>
        {/if}
        <p class="hint">
            {#if method === 'address'}
                Get the Node ID from the other device's "My Device" card, and its address from
                whatever gives it a name that does not change, such as Tailscale. The port is
                optional. Afterwards, add this device's address over there too: either device may be
                the one that reconnects.
            {:else}
                Get the Node ID from the other device's "My Device" card above (copy/paste, or scan
                its QR code). Nothing else is needed; the two devices find each other on the network
                they share.
            {/if}
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
    .method-choice {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 4px 0;
        padding: 0;
        border: none;
    }
    .method-legend {
        padding: 0 0 8px 0;
        font-size: 13px;
        color: var(--text-secondary);
    }
    .method-option {
        display: flex;
        flex-direction: column;
        gap: 2px;
        /* Wraps to one per line rather than squeezing two into a phone's
           width, where the second line of each would be three words tall. */
        flex: 1 1 200px;
        padding: 10px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        cursor: pointer;
    }
    .method-option:hover {
        background: var(--bg-hover);
    }
    .method-option.selected {
        border-color: var(--accent-color);
    }
    /* The radio itself is redundant next to the selected border, but it is
       what makes this a radio group to a screen reader and to the keyboard.
       Clipped rather than hidden with opacity or display: both of those drop
       it out of the accessibility tree in at least one engine, which would
       leave the choice mouse-only. */
    .method-option input {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        border: 0;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    .method-option:focus-within {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }
    .method-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
    }
    .method-detail {
        font-size: 12px;
        color: var(--text-muted);
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
