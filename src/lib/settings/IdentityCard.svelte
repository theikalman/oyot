<script lang="ts">
    import type { UserIdentity } from '$lib/stores/sync';

    interface Props {
        identity: UserIdentity | null;
        onCopy: () => void;
        copySuccess: boolean;
    }

    let { identity, onCopy, copySuccess }: Props = $props();
</script>

<section class="section">
    <h2>My Device</h2>
    {#if identity}
        <div class="identity-card">
            <div class="identity-header">
                <span class="device-icon">📱</span>
                <span class="device-name">{identity.display_name}</span>
            </div>
            <div class="identity-row">
                <span class="identity-label">Node ID</span>
                <div class="identity-value-row">
                    <span class="identity-value mono">{identity.node_id}</span>
                    <button class="copy-btn" onclick={onCopy}>
                        {copySuccess ? 'Copied!' : 'Copy'}
                    </button>
                </div>
            </div>
            <div class="identity-row">
                <span class="identity-label">User ID</span>
                <span class="identity-value mono">{identity.user_id}</span>
            </div>
            <p class="hint">Share your Node ID with another device to pair.</p>
        </div>
    {:else}
        <div class="loading">Loading identity...</div>
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
    .identity-card {
        padding: 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
    }
    .identity-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border-color);
    }
    .device-icon {
        font-size: 24px;
    }
    .device-name {
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .identity-row {
        margin-bottom: 8px;
    }
    .identity-label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .identity-value-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .identity-value {
        font-size: 12px;
        color: var(--text-primary);
        word-break: break-all;
    }
    .mono {
        font-family: monospace;
    }
    .copy-btn {
        padding: 4px 8px;
        background: transparent;
        color: var(--accent-color);
        border: 1px solid var(--accent-color);
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        flex-shrink: 0;
    }
    .copy-btn:hover {
        background: var(--accent-bg);
    }
    .hint {
        margin: 12px 0 0 0;
        font-size: 12px;
        color: var(--text-muted);
    }
    .loading {
        padding: 16px;
        text-align: center;
        color: var(--text-muted);
    }
</style>