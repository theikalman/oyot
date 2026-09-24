<script lang="ts">
    import { get } from 'svelte/store';
    import type { DocumentSummary } from '../types';
    import { appStore } from '../stores/app';
    import { deleteDocument } from '../services/documentActions';
    import { openDocument, openHome } from '../services/navigation';
    import Modal from './Modal.svelte';

    interface Props {
        doc: DocumentSummary;
        onClose: () => void;
    }

    let { doc, onClose }: Props = $props();

    let error = $state<string | null>(null);

    async function confirm() {
        const docId = doc.id;
        const wasOpen = get(appStore).currentDocument?.id === docId;

        // Nothing is cleared until the delete has actually succeeded. Clearing
        // the open document first left the editor on a permanent "Loading..."
        // with no way back whenever the delete failed, and whenever the note
        // deleted was the last one.
        error = null;
        try {
            await deleteDocument(docId);
        } catch (err) {
            console.error('[notes] Failed to delete document:', err);
            error = 'Could not delete this note.';
            return;
        }

        onClose();
        if (wasOpen) {
            const nextNote = get(appStore).documents.find(
                (d: DocumentSummary) => d.doc_type === 'note' && d.id !== docId,
            );
            // No note left to fall back to, so go to the entry point, which
            // opens today's journal.
            await (nextNote ? openDocument(nextNote.id) : openHome());
        }
    }
</script>

<Modal title={`Delete "${doc.title}"?`} {onClose}>
    <p class="modal-warning">
        This can't be undone. If this note has been synchronized to other devices, it will be
        deleted there too.
    </p>
    {#if error}
        <p class="modal-error">{error}</p>
    {/if}
    {#snippet actions()}
        <button class="modal-btn secondary" data-secondary onclick={onClose}>Cancel</button>
        <button class="modal-btn danger" onclick={confirm}>Delete</button>
    {/snippet}
</Modal>

<style>
    .modal-error {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: var(--status-error);
    }

    .modal-warning {
        margin: 0 0 4px 0;
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.4;
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

    .modal-btn.danger {
        background: #ef4444;
    }

    .modal-btn.danger:hover {
        background: #dc2626;
    }
</style>
