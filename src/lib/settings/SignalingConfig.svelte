<script lang="ts">
    interface Props {
        signalingUrl: string | null;
        isConnected: boolean;
        onSave: (url: string) => void;
    }

    let { signalingUrl, isConnected, onSave }: Props = $props();

    let inputUrl = $state(signalingUrl ?? '');
    let isEditing = $state(!signalingUrl);

    $effect(() => {
        inputUrl = signalingUrl ?? '';
        isEditing = !signalingUrl;
    });

    function handleSave() {
        if (!inputUrl.trim()) return;
        onSave(inputUrl.trim());
        isEditing = false;
    }
</script>

<section class="section">
    <h2>MQTT Broker</h2>
    {#if isEditing}
        <form class="signaling-form" onsubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <input
                type="text"
                placeholder="mqtt://localhost:1883"
                bind:value={inputUrl}
                class="input"
            />
            <button type="submit" class="btn-primary" disabled={!inputUrl.trim()}>
                Save & Connect
            </button>
        </form>
    {:else}
        <div class="signaling-display">
            <div class="url-row">
                <span class="url">{signalingUrl}</span>
                <button class="btn-link" onclick={() => isEditing = true}>Edit</button>
            </div>
            <div class="status-row">
                <span class="status-dot {isConnected ? 'connected' : 'disconnected'}"></span>
                <span class="status-label">
                    {isConnected ? 'Connected to MQTT' : 'Disconnected'}
                </span>
            </div>
        </div>
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
    .signaling-form {
        display: flex;
        gap: 8px;
    }
    .input {
        flex: 1;
        padding: 10px 12px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 14px;
        background: var(--bg-primary);
        color: var(--text-primary);
    }
    .input:focus {
        outline: none;
        border-color: var(--accent-color);
    }
    .btn-primary {
        padding: 10px 16px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        white-space: nowrap;
    }
    .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .signaling-display {
        padding: 12px 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
    }
    .url-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .url {
        font-family: monospace;
        font-size: 13px;
        color: var(--text-primary);
    }
    .btn-link {
        background: none;
        border: none;
        color: var(--accent-color);
        cursor: pointer;
        font-size: 13px;
        padding: 0;
    }
    .status-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
    }
    .status-dot.connected {
        background: #22c55e;
    }
    .status-dot.disconnected {
        background: #9ca3af;
    }
    .status-label {
        font-size: 12px;
        color: var(--text-muted);
    }
</style>