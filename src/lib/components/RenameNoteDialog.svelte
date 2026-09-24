<script lang="ts">
    import { untrack } from 'svelte';
    import type { DocumentSummary } from '../types';
    import { renameDocument } from '../services/documentActions';
    import Modal from './Modal.svelte';

    interface Props {
        doc: DocumentSummary;
        onClose: () => void;
    }

    let { doc, onClose }: Props = $props();

    // Starts at the current title and is the user's from then on. A rename
    // arriving from a peer while the dialog is open must not replace what
    // they are in the middle of typing.
    let title = $state(untrack(() => doc.title));
    let error = $state<string | null>(null);

    async function confirm() {
        if (!title.trim()) return;

        error = null;
        try {
            await renameDocument(doc.id, title.trim());
        } catch (err) {
            // Closing in a `finally` threw the edit away on failure and left
            // the user believing the rename had worked.
            console.error('[notes] Failed to rename document:', err);
            error = 'Could not rename this note.';
            return;
        }
        onClose();
    }
</script>

<Modal title="Rename" {onClose}>
    <input
        type="text"
        bind:value={title}
        placeholder="Enter file name..."
        class="modal-input"
        onkeydown={(e) => e.key === 'Enter' && confirm()}
    />
    {#if error}
        <p class="modal-error">{error}</p>
    {/if}
    {#snippet actions()}
        <button class="modal-btn secondary" data-secondary onclick={onClose}>Cancel</button>
        <button class="modal-btn" onclick={confirm}>Rename</button>
    {/snippet}
</Modal>

<style>
    .modal-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        box-sizing: border-box;
        background: var(--bg-secondary);
        color: var(--text-primary);
    }

    .modal-input::placeholder {
        color: var(--text-muted);
    }

    .modal-error {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: var(--status-error);
    }

    .modal-btn {
        padding: 6px 16px;
        background: var(--btn-primary-bg);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    }

    .modal-btn:hover {
        background: var(--btn-primary-hover);
    }

    .modal-btn.secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
    }

    .modal-btn.secondary:hover {
        background: var(--bg-hover);
    }
</style>
