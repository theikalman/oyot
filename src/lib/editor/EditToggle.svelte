<script lang="ts">
    import { editShortcutLabel } from './editorMode';

    // Switches the open document between reading and editing. It reads
    // "Edit" while reading and "Done" while editing: what pressing it does,
    // in the words a phone's own apps use for the same switch. Done is in the
    // accent colour, so a document that can be typed into looks it.
    interface Props {
        editing: boolean;
        onToggle: () => void;
    }

    let { editing, onToggle }: Props = $props();

    const shortcut = editShortcutLabel();
    let label = $derived(editing ? 'Done' : 'Edit');
    let hint = $derived(
        `${editing ? 'Stop editing and go back to reading' : 'Edit this page'} (${shortcut})`,
    );
</script>

<!-- Named by aria-label as well as by its text, because on a phone the text
     is hidden and the icon alone has to carry it. -->
<button class="edit-toggle" class:editing onclick={onToggle} title={hint} aria-label={label}>
    <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        {#if editing}
            <path d="M20 6 9 17l-5-5" />
        {:else}
            <path
                d="M2.876 18.116c.046-.414.069-.62.131-.814a2 2 0 0 1 .234-.485c.111-.17.259-.317.553-.61L17 3a2.828 2.828 0 1 1 4 4L7.794 20.206c-.294.294-.442.442-.611.553a2 2 0 0 1-.485.233c-.193.063-.4.086-.814.132L2.5 21.5z"
            />
        {/if}
    </svg>
    <span class="label">{label}</span>
</button>

<style>
    .edit-toggle {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border-light);
        border-radius: 16px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        line-height: 16px;
        color: var(--text-primary);
        transition:
            background-color 0.2s,
            border-color 0.2s;
    }

    .edit-toggle:hover {
        background: var(--bg-hover);
    }

    .edit-toggle.editing {
        background: var(--accent-bg);
        border-color: var(--accent-color);
        color: var(--accent-color);
    }

    .edit-toggle.editing:hover {
        background: var(--accent-bg-hover);
    }

    /* A phone's header is shared with the title, which wraps onto more lines
       for every pixel taken from it. The pencil and the tick say enough. */
    @media (max-width: 480px) {
        .edit-toggle {
            padding: 6px;
        }

        .label {
            display: none;
        }
    }
</style>
