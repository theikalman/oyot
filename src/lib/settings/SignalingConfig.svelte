<script lang="ts">
    import type { SignalingStatus } from '$lib/stores/sync';

    interface Props {
        signalingUrl: string | null;
        status: SignalingStatus;
        /** Why the connection failed, when `status` is 'error'. */
        error: string | null;
        onSave: (url: string) => void;
    }

    let { signalingUrl, status, error, onSave }: Props = $props();

    // A boolean could not tell "still trying" from "tried and failed", so a
    // wrong address or a rejected login read as an ordinary disconnection and
    // the user had nothing to act on.
    const LABELS: Record<SignalingStatus, string> = {
        connected: 'Connected to MQTT',
        connecting: 'Connecting...',
        disconnected: 'Disconnected',
        error: 'Cannot reach this broker',
    };

    // Seeded from the prop, then owned by the field. The effect used to assign
    // both of these on every run, so any store update -- a reconnect, a status
    // change -- wiped whatever was half-typed in the box.
    let inputUrl = $state('');
    let isEditing = $state(false);

    // Deliberately not $state: the effect must not re-run when this is written,
    // and it must not treat `isEditing` as a dependency either.
    let lastSeenUrl: string | null | undefined;

    $effect(() => {
        const incoming = signalingUrl;
        if (incoming === lastSeenUrl) return;
        lastSeenUrl = incoming;
        inputUrl = incoming ?? '';
        // With no broker configured there is nothing to display, so open
        // straight into the form.
        isEditing = !incoming;
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
        <form
            class="signaling-form"
            onsubmit={(e) => {
                e.preventDefault();
                handleSave();
            }}
        >
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
                <button class="btn-link" onclick={() => (isEditing = true)}>Edit</button>
            </div>
            <div class="status-row">
                <span class="status-dot {status}"></span>
                <span class="status-label">{LABELS[status]}</span>
            </div>
            {#if status === 'error' && error}
                <p class="status-detail">{error}</p>
            {/if}
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
        background: var(--status-ok, #22c55e);
    }
    .status-dot.connecting {
        background: var(--status-pending, #f59e0b);
    }
    .status-dot.disconnected {
        background: var(--status-idle, #9ca3af);
    }
    .status-dot.error {
        background: var(--status-error, #ef4444);
    }
    .status-detail {
        margin: 8px 0 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
        word-break: break-word;
    }
    .status-label {
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
