<script lang="ts">
    import QRCode from 'qrcode';

    interface Props {
        nodeId: string | null;
        qrCodeDataUrl: string | null;
        showQrCode: boolean;
        copySuccess: boolean;
        onToggleQr: () => void;
        onCopy: () => void;
    }

    let {
        nodeId,
        qrCodeDataUrl,
        showQrCode,
        copySuccess,
        onToggleQr,
        onCopy
    }: Props = $props();

    let qrImageUrl = $state<string | null>(null);

    $effect(() => {
        if (nodeId && showQrCode && !qrCodeDataUrl) {
            QRCode.toDataURL(nodeId, {
                width: 200,
                margin: 2,
                color: { dark: '#333333', light: '#ffffff' }
            }).then(url => {
                qrImageUrl = url;
            }).catch(() => {
                qrImageUrl = null;
            });
        } else {
            qrImageUrl = qrCodeDataUrl;
        }
    });
</script>

<section class="section">
    <h2>This Device</h2>
    <div class="node-id-card">
        <div class="node-id-label">Your Node ID</div>
        <div class="node-id-value">{nodeId || 'Not available'}</div>
        <button class="copy-btn" onclick={onCopy} disabled={!nodeId}>
            {copySuccess ? 'Copied!' : 'Copy'}
        </button>
        {#if qrCodeDataUrl || qrImageUrl}
            <button class="qr-toggle-btn" onclick={onToggleQr}>
                {showQrCode ? 'Hide QR' : 'Show QR'}
            </button>
        {/if}
    </div>
    {#if showQrCode && (qrImageUrl || qrCodeDataUrl)}
        <div class="qr-code-container">
            <img src={qrImageUrl || qrCodeDataUrl} alt="QR Code for Node ID" class="qr-code" />
            <p class="qr-help-text">Scan this QR code with another device to pair</p>
        </div>
    {/if}
    <p class="help-text">
        Share this ID with other devices to sync with them.
    </p>
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

    .node-id-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        flex-wrap: wrap;
    }

    .node-id-label {
        font-size: 12px;
        color: var(--text-muted);
        width: 100%;
    }

    .node-id-value {
        flex: 1;
        font-family: monospace;
        font-size: 13px;
        word-break: break-all;
        color: var(--text-primary);
    }

    .copy-btn {
        padding: 6px 12px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .copy-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .qr-toggle-btn {
        padding: 6px 12px;
        background: var(--bg-hover);
        color: var(--text-primary);
        border: 1px solid var(--border-light);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .qr-toggle-btn:hover {
        background: var(--border-color);
    }

    .help-text {
        margin: 8px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }

    .qr-code-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-top: 16px;
        padding: 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
    }

    .qr-code {
        width: 200px;
        height: 200px;
    }

    .qr-help-text {
        margin: 8px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>