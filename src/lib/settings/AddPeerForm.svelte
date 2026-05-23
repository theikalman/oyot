<script lang="ts">
    interface Props {
        isAdding: boolean;
        onSubmit: (nodeId: string, deviceName: string) => void;
    }

    let { isAdding, onSubmit }: Props = $props();

    let newPeerNodeId = $state('');
    let newPeerDeviceName = $state('');

    function handleSubmit() {
        if (!newPeerNodeId.trim() || !newPeerDeviceName.trim()) return;
        onSubmit(newPeerNodeId.trim(), newPeerDeviceName.trim());
        newPeerNodeId = '';
        newPeerDeviceName = '';
    }

    let isValid = $derived(newPeerNodeId.trim() !== '' && newPeerDeviceName.trim() !== '');
</script>

<section class="section">
    <h2>Add Device</h2>
    <form class="add-peer-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <input
            type="text"
            placeholder="Device Node ID"
            bind:value={newPeerNodeId}
            class="input"
        />
        <input
            type="text"
            placeholder="Device name (e.g., My iPad)"
            bind:value={newPeerDeviceName}
            class="input"
        />
        <button type="submit" class="btn-primary" disabled={isAdding || !isValid}>
            {isAdding ? 'Adding...' : 'Add Device'}
        </button>
    </form>
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

    .add-peer-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .input {
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
    }

    .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>