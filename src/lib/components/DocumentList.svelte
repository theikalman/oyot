<script lang="ts">
    import type { DocumentSummary } from '$lib/types';

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
                <span class="doc-type"
                    ><svg
                        width="16"
                        height="16"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        ><path
                            stroke="#A1A1A1"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="1.5"
                            d="M14 2.27V6.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437c.214.11.494.11 1.054.11h4.13M16 13H8m8 4H8m2-8H8m6-7H8.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C4 4.28 4 5.12 4 6.8v10.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C6.28 22 7.12 22 8.8 22h6.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C20 19.72 20 18.88 20 17.2V8z"
                        /></svg
                    ></span
                >
                {doc.title}
                {#if doc.todo_count > 0}
                    <span
                        class="todo-badge"
                        class:done={doc.completed_todo_count === doc.todo_count}
                        title="{doc.completed_todo_count} of {doc.todo_count} done"
                    >
                        {doc.completed_todo_count}/{doc.todo_count}
                    </span>
                {/if}
            </button>
            <button
                class="doc-menu-btn"
                onclick={(e) => onToggleMenu(e, doc.id)}
                title="Note options"
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
    .todo-badge {
        margin-left: 6px;
        padding: 1px 6px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        background: var(--bg-hover);
        border-radius: 8px;
        white-space: nowrap;
    }

    .todo-badge.done {
        color: var(--accent-color);
        background: var(--accent-bg);
    }

    .doc-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .doc-list li {
        margin-bottom: 4px;
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
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .doc-btn:hover {
        background: var(--bg-hover);
    }

    .doc-btn.current {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .doc-menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
    }

    /* Revealed on hover or keyboard focus. Without these the button is
       permanently at opacity 0 and the row menu is unreachable. */
    .doc-item:hover .doc-menu-btn,
    .doc-menu-btn:focus-visible {
        opacity: 1;
    }

    .doc-menu-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .doc-menu {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        z-index: 50;
        min-width: 120px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .doc-menu-item {
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
        color: var(--text-primary);
    }

    .doc-menu-item:hover {
        background: var(--bg-hover);
    }

    .doc-menu-item.danger {
        color: #ef4444;
    }

    .doc-type {
        margin-right: 6px;
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        margin-top: -4px;
    }
</style>
