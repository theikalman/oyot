<script lang="ts">
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocumentAtTodo } from '$lib/services/navigation';
    import { formatJournalTitle } from '$lib/calendar/calendar';
    import { createTodoIndex } from '$lib/todos/todoStore.svelte';
    import type { TodoGroup, TodoHit } from '$lib/todos/grouping';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // Every task item in every note and journal, on one page.
    //
    // The rows come from SQL, not from the documents: content lives in the
    // CRDT, and the indexer records each task item as it is written or merged
    // (see src/lib/editor/documentIndex.ts). That is what makes this page
    // cover documents this device has only ever received, and what makes a
    // peer ticking something off show up here.
    const todos = createTodoIndex();

    // Reloaded on every change to any document's derived rows: an edit here,
    // an edit on another route, a rename, a delete, a peer's edit arriving
    // while this page is open. Cheap enough to redo wholesale, and the
    // alternative is a second copy of the indexer's rules living here.
    $effect(() => {
        void $indexRevision;
        void todos.load();
    });

    let hideCompleted = $state(false);

    // Held in state rather than read at render time, so a page left open
    // overnight stops calling yesterday's journal "Today".
    let today = $state(new Date());

    $effect(() => {
        const refresh = () => {
            const now = new Date();
            if (now.toDateString() !== today.toDateString()) today = now;
        };
        const timer = setInterval(refresh, 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    });

    function visible(group: TodoGroup): TodoHit[] {
        return hideCompleted ? group.todos.filter((todo) => !todo.checked) : group.todos;
    }

    // A group whose every item is done disappears with them, rather than
    // leaving a heading with nothing under it.
    function shown(groups: TodoGroup[]): TodoGroup[] {
        return groups.filter((group) => visible(group).length > 0);
    }

    function heading(group: TodoGroup): string {
        return group.docType === 'journal' ? formatJournalTitle(group.title, today) : group.title;
    }

    function open(todo: TodoHit) {
        void openDocumentAtTodo(todo.document_id, todo.ordinal);
    }

    let journals = $derived(shown(todos.sections.journals));
    let notes = $derived(shown(todos.sections.notes));
    let nothingToShow = $derived(journals.length === 0 && notes.length === 0);
</script>

<WorkspaceShell title="Todos">
    <div class="todos">
        <div class="todos-bar">
            <p class="summary">
                {#if todos.loading && todos.isEmpty}
                    Collecting your todos...
                {:else if todos.failed}
                    &nbsp;
                {:else}
                    {todos.openCount} open of {todos.totalCount}
                {/if}
            </p>
            <label class="filter">
                <input type="checkbox" bind:checked={hideCompleted} />
                Hide completed
            </label>
        </div>

        {#if todos.failed}
            <p class="note error">
                Could not read your todos right now. They are still in your notes.
            </p>
        {:else if todos.loading && todos.isEmpty}
            <p class="note">Loading...</p>
        {:else if todos.isEmpty}
            <p class="note">
                Nothing yet. Type <code>/todo</code> in any note or journal and it will show up here.
            </p>
        {:else if nothingToShow}
            <p class="note">Everything here is done.</p>
        {:else}
            {#each [{ label: 'Journals', groups: journals }, { label: 'Notes', groups: notes }] as section (section.label)}
                {#if section.groups.length > 0}
                    <section class="section">
                        <h2 class="section-title">{section.label}</h2>
                        {#each section.groups as group (group.docId)}
                            <div class="group">
                                <h3 class="group-title">{heading(group)}</h3>
                                <ul class="todo-list">
                                    {#each visible(group) as todo (todo.ordinal)}
                                        <li>
                                            <button
                                                class="todo"
                                                class:done={todo.checked}
                                                style="padding-left: {8 + todo.depth * 20}px"
                                                onclick={() => open(todo)}
                                                title="Open in {group.title}"
                                            >
                                                <!-- A picture of the checkbox, not the
                                                     checkbox: this page opens the note,
                                                     it does not edit it. -->
                                                <span class="box" aria-hidden="true">
                                                    {todo.checked ? '☑' : '☐'}
                                                </span>
                                                <span class="text" class:empty={!todo.text}>
                                                    {todo.text || 'Empty item'}
                                                </span>
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            </div>
                        {/each}
                    </section>
                {/if}
            {/each}
        {/if}
    </div>
</WorkspaceShell>

<style>
    .todos {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 32px;
    }

    .todos-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 8px;
    }

    .summary {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .filter {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
    }

    .filter input {
        accent-color: var(--accent-color);
        cursor: pointer;
    }

    .note {
        margin: 24px 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .note.error {
        color: var(--status-error);
    }

    .note code {
        background: var(--code-bg);
        color: var(--text-primary);
        padding: 1px 5px;
        border-radius: 3px;
    }

    .section {
        margin-top: 20px;
    }

    .section-title {
        margin: 0 0 4px 0;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }

    .group {
        margin-top: 12px;
    }

    .group-title {
        margin: 0 0 2px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .todo-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .todo {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        padding: 5px 8px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
        line-height: 1.5;
    }

    .todo:hover {
        background: var(--bg-hover);
    }

    .todo .box {
        flex-shrink: 0;
        color: var(--text-secondary);
    }

    .todo.done .text {
        color: var(--text-muted);
        text-decoration: line-through;
    }

    .todo .text.empty {
        color: var(--text-muted);
        font-style: italic;
    }
</style>
