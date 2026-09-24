<script lang="ts">
    import { untrack } from 'svelte';
    import { createNote } from '../services/documentActions';
    import { openDocument } from '../services/navigation';
    import { openNextForEditing } from '../editor/editorMode';
    import Modal from './Modal.svelte';

    // Starting a note: ask for its title, make it, open it.
    interface Props {
        /**
         * Whether the note starts out pinned to the sidebar. Shown as a
         * checkbox, so where a new note will end up is never a surprise.
         */
        pinned?: boolean;
        onClose: () => void;
    }

    let { pinned: pinnedAtFirst = false, onClose }: Props = $props();

    let title = $state('');
    // Seeded once; from then on the checkbox is the user's.
    let pinned = $state(untrack(() => pinnedAtFirst));
    let error = $state<string | null>(null);

    async function create() {
        if (!title.trim()) return;

        error = null;
        let doc;
        try {
            doc = await createNote(title.trim(), pinned);
        } catch (err) {
            // Keep the dialog open with what was typed still in it. Closing
            // regardless discarded the title and said nothing went wrong.
            console.error('Failed to create document:', err);
            error = 'Could not create this note.';
            return;
        }
        onClose();
        // Made to be written in, so it skips reading.
        openNextForEditing(doc.id);
        await openDocument(doc.id);
    }
</script>

<Modal title="New Note" {onClose}>
    <input
        type="text"
        bind:value={title}
        placeholder="Enter file name..."
        class="modal-input"
        onkeydown={(e) => e.key === 'Enter' && create()}
    />
    <label class="pin-choice">
        <input type="checkbox" bind:checked={pinned} />
        Pin to the sidebar
    </label>
    {#if error}
        <p class="modal-error">{error}</p>
    {/if}
    {#snippet actions()}
        <button class="modal-btn" onclick={create}>OK</button>
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

    .pin-choice {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 10px 0 0 0;
        font-size: 13px;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .modal-error {
        margin: 10px 0 0 0;
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
</style>
