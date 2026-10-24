<script lang="ts">
    import type { DocumentSummary } from '$lib/types';
    import Icon from './Icon.svelte';

    // One row definition, used for both notes and journals. Journals had no
    // list at all until recently, and giving them one by copying seventy
    // lines of markup is how two lists quietly drift apart.
    interface Props {
        documents: DocumentSummary[];
        currentDocId: string | undefined;
        /**
         * Which row's menu is open. Held by the parent so only one list at a
         * time can have one showing.
         */
        openMenuId: string | null;
        onOpen: (doc: DocumentSummary) => void;
        onToggleMenu: (e: MouseEvent, docId: string) => void;
        onRename: (doc: DocumentSummary) => void;
        onDelete: (doc: DocumentSummary) => void;
        /** Offered in the menu when given, as Pin or Unpin for the row. */
        onTogglePin?: (doc: DocumentSummary) => void;
    }

    let {
        documents,
        currentDocId,
        openMenuId,
        onOpen,
        onToggleMenu,
        onRename,
        onDelete,
        onTogglePin,
    }: Props = $props();
</script>

<ul class="doc-list">
    {#each documents as doc (doc.id)}
        <li class="doc-item">
            <button
                class="doc-btn"
                class:current={currentDocId === doc.id}
                onclick={() => onOpen(doc)}
            >
                <span class="doc-type"><Icon name="note" size={16} /></span>
                <span class="doc-title">{doc.title}</span>
                {#if doc.todo_count > doc.completed_todo_count}
                    <span
                        class="todo-count"
                        title="{doc.todo_count -
                            doc.completed_todo_count} of {doc.todo_count} still open"
                    >
                        {doc.todo_count - doc.completed_todo_count}
                    </span>
                {/if}
            </button>
            <button
                class="doc-menu-btn"
                onclick={(e) => onToggleMenu(e, doc.id)}
                title="Note options"
                aria-expanded={openMenuId === doc.id}
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle
                        cx="12"
                        cy="19"
                        r="1"
                    /></svg
                >
            </button>
            {#if openMenuId === doc.id}
                <div class="doc-menu">
                    {#if onTogglePin}
                        <button class="doc-menu-item" onclick={() => onTogglePin(doc)}>
                            {doc.pinned ? 'Unpin' : 'Pin'}
                        </button>
                    {/if}
                    <button class="doc-menu-item" onclick={() => onRename(doc)}>Rename</button>
                    <button class="doc-menu-item danger" onclick={() => onDelete(doc)}
                        >Delete</button
                    >
                </div>
            {/if}
        </li>
    {/each}
</ul>

<style>
    /* How many are still open, in the colour open todos always have. A
       note with every todo done shows nothing: there is nothing to do. */
    .todo-count {
        margin-left: auto;
        padding-left: 8px;
        font-size: 12px;
        font-weight: 550;
        font-variant-numeric: tabular-nums;
        color: var(--todo-text);
    }

    .doc-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .doc-list li {
        margin-bottom: 1px;
    }

    .doc-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .doc-btn {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        height: 32px;
        text-align: left;
        padding: 0 10px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: var(--radius-md);
        font-size: 13.5px;
        color: var(--text-secondary);
    }

    .doc-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .doc-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* The open note, lifted out of the frame like the current place. */
    .doc-btn.current {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sheet);
    }

    /* Always shown. It used to appear only while the pointer was over the
       row, and a touch screen has no pointer to hover with: on a phone the
       menu was an empty strip at the end of each row that only a lucky tap
       found. */
    .doc-menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 7px;
        cursor: pointer;
    }

    /* Lit while its menu is open, so it stays plain which row the menu
       belongs to once the pointer is in it. */
    .doc-menu-btn[aria-expanded='true'] {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* And under the pointer, but only where there is one. A phone counts
       the last button tapped as hovered until a tap lands somewhere else,
       so closing a menu with its own button left the button lit as if the
       menu were still open. */
    @media (hover: hover) {
        /* With a pointer the menu's dots wait for it, so the list reads as
           names only. A touch screen keeps them, having nothing to hover
           with. */
        .doc-menu-btn {
            opacity: 0;
        }

        .doc-item:hover .doc-menu-btn,
        .doc-menu-btn:focus-visible,
        .doc-menu-btn[aria-expanded='true'] {
            opacity: 1;
        }

        .doc-menu-btn:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
    }

    /* Sized for a finger. The button looks the same, but what a tap can
       land on is 44px wide, the least Apple's guidelines allow, and reaches
       halfway to the rows above and below. A tap just beside the dots opens
       the menu, where it opened the note and, on a phone, put the sidebar
       away. The platform's tap flash would outline that whole area, so the
       button lighting up with its menu is the feedback instead. */
    @media (pointer: coarse) {
        .doc-menu-btn {
            position: relative;
            -webkit-tap-highlight-color: transparent;
        }

        .doc-menu-btn::after {
            content: '';
            position: absolute;
            inset: -4px -10px;
        }
    }

    .doc-menu {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        z-index: 50;
        min-width: 180px;
        background: var(--bg-raised);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-pop);
        padding: 6px;
        display: flex;
        flex-direction: column;
    }

    .doc-menu-item {
        text-align: left;
        height: 34px;
        padding: 0 10px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: var(--radius-md);
        font-size: 13.5px;
        color: var(--text-primary);
    }

    .doc-menu-item:hover {
        background: var(--bg-hover);
    }

    .doc-menu-item.danger {
        color: var(--error-text);
    }

    .doc-type {
        color: var(--text-muted);
        display: inline-flex;
    }
</style>
