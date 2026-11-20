<script lang="ts">
    import { untrack } from 'svelte';
    import Modal from '$lib/components/Modal.svelte';

    interface Props {
        /** The image's description now, '' when it has none. */
        alt: string;
        onSave: (alt: string) => void;
        onClose: () => void;
    }

    let { alt, onSave, onClose }: Props = $props();

    // The user's from the moment the dialog opens, as a rename's title is.
    let text = $state(untrack(() => alt));

    function save() {
        onSave(text);
        onClose();
    }

    function onKeydown(event: KeyboardEvent) {
        // A description is one line; Enter saves it, as in a rename.
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            save();
        }
    }
</script>

<Modal title="Alt text" {onClose}>
    <p class="hint">
        Describe the image for anyone who cannot see it. Leave it empty to remove it.
    </p>
    <textarea
        bind:value={text}
        rows="3"
        maxlength="1000"
        placeholder="A short description of the image"
        class="modal-input"
        onkeydown={onKeydown}></textarea>
    {#snippet actions()}
        <button class="modal-btn secondary" data-secondary onclick={onClose}>Cancel</button>
        <button class="modal-btn" onclick={save}>Save</button>
    {/snippet}
</Modal>

<style>
    .hint {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .modal-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        font-family: inherit;
        line-height: 1.5;
        resize: vertical;
        box-sizing: border-box;
        background: var(--bg-secondary);
        color: var(--text-primary);
    }

    .modal-input::placeholder {
        color: var(--text-muted);
    }

    .modal-btn {
        padding: 6px 16px;
        background: var(--btn-primary-bg);
        color: var(--on-accent);
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
