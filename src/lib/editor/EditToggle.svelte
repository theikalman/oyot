<script lang="ts">
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import Icon from '$lib/components/Icon.svelte';

    // Switches the open document between reading and editing: Read and Edit
    // side by side, the one that is on raised like the current place in the
    // sidebar.
    interface Props {
        editing: boolean;
        onToggle: () => void;
    }

    let { editing, onToggle }: Props = $props();

    // Its keys, which the user may have changed, or left it without.
    let shortcut = $derived(customShortcuts.labelFor('edit'));
    let hint = $derived(
        `${editing ? 'Stop editing and go back to reading' : 'Edit this page'}${shortcut ? ` (${shortcut})` : ''}`,
    );
</script>

<!-- One switch with both modes on it, so which one is on is plain from
     across the room, and pressing either says what it does. -->
<div class="mode-switch" role="group" aria-label="Mode" title={hint}>
    <button class:on={!editing} aria-pressed={!editing} onclick={() => editing && onToggle()}>
        <Icon name="read" size={15} />
        <span class="label">Read</span>
    </button>
    <button class:on={editing} aria-pressed={editing} onclick={() => !editing && onToggle()}>
        <Icon name="edit" size={15} />
        <span class="label">Edit</span>
    </button>
</div>

<style>
    .mode-switch {
        flex-shrink: 0;
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 10px;
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
    }

    .mode-switch button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 550;
        cursor: pointer;
    }

    .mode-switch button:hover:not(.on) {
        color: var(--text-primary);
    }

    .mode-switch button.on {
        background: var(--bg-raised);
        color: var(--text-primary);
        box-shadow:
            0 0 0 1px var(--border-color),
            0 1px 2px rgba(0, 0, 0, 0.07);
        cursor: default;
    }

    /* A phone's header is shared with the title. The icons say enough. */
    @media (max-width: 480px) {
        .mode-switch button {
            padding: 0 9px;
            height: 32px;
        }

        .label {
            display: none;
        }
    }
</style>
