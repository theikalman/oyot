<script lang="ts">
    import type { Editor } from '@tiptap/core';
    import { FORMATTING, HISTORY, type Tool } from './toolbarTools';

    interface Props {
        editor: Editor | null;
    }

    let { editor }: Props = $props();

    // Undo and redo go last, as a group of their own.
    const groups = [...FORMATTING, HISTORY];
</script>

{#snippet button(tool: Tool)}
    <button
        type="button"
        class="tool"
        title={tool.label}
        aria-label={tool.label}
        onclick={() => editor && tool.run(editor)}
    >
        <svg viewBox="0 0 24 24" aria-hidden="true">
            {#each tool.icon as d, i (i)}
                <path {d} />
            {/each}
        </svg>
    </button>
{/snippet}

<div class="toolbar" role="toolbar" aria-label="Formatting">
    {#each groups as group, i (i)}
        {#if i > 0}
            <span class="separator" aria-hidden="true"></span>
        {/if}
        {#each group as tool (tool.id)}
            {@render button(tool)}
        {/each}
    {/each}
</div>

<style>
    .toolbar {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 4px 12px;
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border-color);
        /* Keep every control on a single row and scroll sideways when the
           screen is too narrow (mobile / tablet) instead of wrapping. */
        flex: 0 0 auto;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-x: contain;
        /* A swipe that starts on a button pans the row rather than starting a
           text selection on the button's label. */
        -webkit-user-select: none;
        user-select: none;
        /* Hide the scrollbar so it never adds height to the toolbar row. */
        scrollbar-width: none;
        -ms-overflow-style: none;
    }

    .toolbar::-webkit-scrollbar {
        display: none;
    }

    /* Only the icon shows until the pointer is on it, as the sidebar's own
       buttons do, so a row of fifteen reads as one quiet strip. */
    .tool {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        transition:
            background-color 0.15s,
            color 0.15s;
    }

    .tool:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .tool:focus-visible {
        outline: 2px solid var(--accent-color);
        outline-offset: -2px;
    }

    .tool svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.75;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    .separator {
        flex: 0 0 1px;
        height: 18px;
        margin: 0 6px;
        background: var(--border-color);
    }
</style>
