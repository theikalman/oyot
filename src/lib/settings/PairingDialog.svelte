<script lang="ts">
    interface Props {
        from: string;
        displayName: string;
        onAccept: () => void;
        onDecline: () => void;
    }

    let { from, displayName, onAccept, onDecline }: Props = $props();
</script>

<div class="modal-backdrop">
    <div class="modal">
        <h3>Pairing Request</h3>
        <p class="message">
            <strong>{displayName}</strong> wants to pair with this device.
        </p>
        <!-- The name is whatever the other device calls itself and proves
             nothing. The id is its public key, and checking it against the
             one shown on that device is the whole point of confirming by
             hand. Dropping it here left the user nothing to check. -->
        <p class="id-label">Device ID</p>
        <code class="node-id">{from}</code>
        <p class="hint">
            Check this matches the ID shown on that device. Accepting lets it sync every document
            with this one, from now on.
        </p>
        <div class="actions">
            <button class="btn-decline" onclick={onDecline}>Decline</button>
            <button class="btn-accept" onclick={onAccept}>Accept</button>
        </div>
    </div>
</div>

<style>
    .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    }
    .modal {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        width: 90%;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }
    h3 {
        margin: 0 0 16px 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .message {
        font-size: 14px;
        color: var(--text-primary);
        margin: 0 0 8px 0;
    }
    .id-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        margin: 12px 0 4px 0;
    }
    .node-id {
        display: block;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.5;
        word-break: break-all;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        padding: 8px;
        color: var(--text-primary);
    }
    .hint {
        font-size: 12px;
        color: var(--text-muted);
        margin: 12px 0 20px 0;
    }
    .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }
    .btn-decline {
        padding: 8px 16px;
        background: transparent;
        color: var(--status-error);
        border: 1px solid var(--status-error);
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
    }
    .btn-accept {
        padding: 8px 16px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
    }
</style>
