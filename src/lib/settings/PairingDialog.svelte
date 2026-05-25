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
        <h3>Incoming Connection</h3>
        <p class="message">
            <strong>{displayName}</strong> wants to connect to this device.
        </p>
        <p class="hint">This device is requesting to sync documents with you.</p>
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
    .hint {
        font-size: 12px;
        color: var(--text-muted);
        margin: 0 0 20px 0;
    }
    .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }
    .btn-decline {
        padding: 8px 16px;
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
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