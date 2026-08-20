<script lang="ts">
    import { onMount } from 'svelte';
    import type { PairingState } from '$lib/stores/sync';

    interface Props {
        pairingState: PairingState;
        onPair: (nodeId: string) => void;
    }

    let { pairingState, onPair }: Props = $props();

    let nodeIdInput = $state('');
    let isMobile = $state(false);
    let scanError = $state<string | null>(null);

    onMount(async () => {
        try {
            const { platform } = await import('@tauri-apps/plugin-os');
            const p = platform();
            isMobile = p === 'android' || p === 'ios';
        } catch (e) {
            console.warn('[PairDeviceForm] Platform detection unavailable, hiding QR scan button:', e);
            isMobile = false;
        }
    });

    function handlePair() {
        const trimmed = nodeIdInput.trim();
        if (!trimmed) return;
        onPair(trimmed);
        nodeIdInput = '';
    }

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
            const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
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
        />
        <div class="pair-actions">
            {#if isMobile}
                <button class="btn-scan" onclick={handleScan}>Scan QR</button>
            {/if}
            <button
                class="btn-pair"
                onclick={handlePair}
                disabled={!nodeIdInput.trim() || pairingState === 'requesting'}
            >
                {pairingState === 'requesting' ? 'Requesting...' : 'Pair'}
            </button>
        </div>
        {#if pairingState === 'declined'}
            <p class="pair-status error">The other device declined the pairing request.</p>
        {/if}
        {#if scanError}
            <p class="pair-status error">{scanError}</p>
        {/if}
        <p class="hint">Get the Node ID from the other device's "My Device" card above (copy/paste, or scan its QR code).</p>
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
    .node-id-input:focus {
        outline: none;
        border-color: var(--accent-color);
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
    .hint {
        margin: 4px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
