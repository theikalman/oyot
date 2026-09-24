<script lang="ts">
    import type { Editor } from '@tiptap/core';
    import { FORMATTING, HISTORY, TOOLS, pressedTools, type Tool } from './toolbarTools';

    interface Props {
        editor: Editor | null;
    }

    let { editor }: Props = $props();

    // Undo and redo go last, as a group of their own.
    const groups = [...FORMATTING, HISTORY];

    // Which tools the selection's formatting is using, shown pressed, and
    // which could do nothing just now, shown disabled.
    let pressed = $state.raw(new Set<string>());
    let unavailable = $state.raw(new Set<string>());

    // Read again after every change to the editor, the caret moving
    // included, and a microtask late. Undo files what it undid on the redo
    // stack only once the change has already been announced, so reading on
    // the announcement would leave Redo disabled after an undo. It also
    // makes one read of however many changes arrived together.
    $effect(() => {
        const ed = editor;
        if (!ed) return;

        let live = true;
        let queued = false;
        const read = () => {
            queued = false;
            if (!live || ed.isDestroyed) return;
            pressed = pressedTools(ed.state);
            unavailable = new Set(
                TOOLS.filter((tool) => tool.canRun?.(ed) === false).map((tool) => tool.id),
            );
        };
        const schedule = () => {
            if (queued) return;
            queued = true;
            queueMicrotask(read);
        };

        read();
        ed.on('transaction', schedule);
        return () => {
            live = false;
            ed.off('transaction', schedule);
        };
    });
</script>

<!-- A press never takes focus from the note. Taking it, even until the
     command gave it back, blinked the selection away and could put a
     phone's keyboard down between one tool and the next. -->
{#snippet button(tool: Tool)}
    <button
        type="button"
        class="tool"
        class:pressed={pressed.has(tool.id)}
        aria-pressed={tool.toggles ? pressed.has(tool.id) : undefined}
        disabled={unavailable.has(tool.id)}
        title={tool.label}
        aria-label={tool.label}
        onmousedown={(event) => event.preventDefault()}
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

    .tool:hover:enabled {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* On where the caret is: tinted the way the sidebar marks the page that
       is open. */
    .tool.pressed {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .tool.pressed:hover:enabled {
        background: var(--accent-bg-hover);
        color: var(--accent-color);
    }

    .tool:disabled {
        cursor: default;
        opacity: 0.35;
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
