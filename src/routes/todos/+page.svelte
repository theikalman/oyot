<script lang="ts">
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocumentAtTodo } from '$lib/services/navigation';
    import { formatJournalTitle } from '$lib/calendar/calendar';
    import { createTodoIndex } from '$lib/todos/todoStore.svelte';
    import { countAll, countOpen, type TodoGroup, type TodoHit } from '$lib/todos/grouping';
    import { findTerms, searchSections, searchTerms } from '$lib/todos/todoSearch';
    import { markSegments, todoSegments, type MarkedRun } from '$lib/todos/todoText';
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

    // On by default: the page is for what is still to do, and an unticked
    // box would bury it under everything already finished. The checkbox is
    // right there for anyone who wants the full history back.
    let hideCompleted = $state(true);

    // Finds a todo by the words in it (see $lib/todos/todoSearch). Filtered
    // here rather than queried, as the Notes and Tags pages filter theirs:
    // every todo is already in hand.
    let query = $state('');
    let terms = $derived(searchTerms(query));
    let searching = $derived(terms.length > 0);

    // What the search finds, finished todos included, which Hide completed
    // then takes out. Everything, while nothing is being searched for.
    let found = $derived(searchSections(todos.sections, terms));
    let foundCount = $derived(countAll(found));

    // Escape empties the box, as it does the sidebar's search.
    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') query = '';
    }

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

    // A row's text as it is drawn: its chips, with what the search found
    // marked, so a todo found by part of a word shows which part.
    function drawn(todo: TodoHit, group: TodoGroup) {
        return markSegments(todoSegments(todo.text, group.tags), findTerms(todo.text, terms) ?? []);
    }

    function open(todo: TodoHit) {
        void openDocumentAtTodo(todo.document_id, todo.ordinal);
    }

    let journals = $derived(shown(found.journals));
    let notes = $derived(shown(found.notes));
    let nothingToShow = $derived(journals.length === 0 && notes.length === 0);
</script>

<!-- Some of a todo's words, with the ones the search found marked. All on
     one line: a space between two runs would land inside a word. -->
{#snippet marked(runs: MarkedRun[])}{#each runs as run, r (r)}{#if run.match}<mark>{run.text}</mark
            >{:else}{run.text}{/if}{/each}{/snippet}

<WorkspaceShell title="Todos">
    <div class="todos">
        <div class="todos-bar">
            <!-- Read out as it changes, so a search says how much it found
                 to someone who cannot see the rows come and go. -->
            <p class="summary" aria-live="polite">
                {#if todos.loading && todos.isEmpty}
                    Collecting your todos...
                {:else if todos.failed}
                    &nbsp;
                {:else if searching}
                    {countOpen(found)} open of {foundCount} matching
                {:else}
                    {todos.openCount} open of {todos.totalCount}
                {/if}
            </p>
            <div class="bar-actions">
                {#if !todos.isEmpty}
                    <input
                        class="search"
                        type="search"
                        placeholder="Search todos"
                        bind:value={query}
                        onkeydown={handleSearchKeydown}
                        aria-label="Search todos"
                    />
                {/if}
                <label class="filter">
                    <input type="checkbox" bind:checked={hideCompleted} />
                    Hide completed
                </label>
            </div>
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
        {:else if searching && nothingToShow}
            <!-- Everything the search found can be finished and hidden, and
                 "no match" would then send someone looking for a todo that
                 is right there behind the checkbox. -->
            <p class="note">
                {#if foundCount === 0}
                    No todo matches "{query.trim()}".
                {:else if foundCount === 1}
                    Only a completed todo matches "{query.trim()}". Untick Hide completed to see it.
                {:else}
                    Only completed todos match "{query.trim()}". Untick Hide completed to see them.
                {/if}
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
                                                    {#if todo.text}
                                                        {#each drawn(todo, group) as segment, i (i)}
                                                            {#if segment.kind === 'tag'}
                                                                <span class="tag-chip"
                                                                    >{@render marked(
                                                                        segment.runs,
                                                                    )}</span
                                                                >
                                                            {:else}
                                                                {@render marked(segment.runs)}
                                                            {/if}
                                                        {/each}
                                                    {:else}
                                                        Empty item
                                                    {/if}
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

    .bar-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
    }

    /* The Notes and Tags pages' filter box. */
    .search {
        padding: 5px 10px;
        font-size: 13px;
        font-family: inherit;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        min-width: 160px;
    }

    .search:focus {
        outline: none;
        border-color: var(--accent-color);
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

    /* The editor's tag chip (EditorInstance.svelte), so a tag reads here the
       way it does in the note it came from. */
    .tag-chip {
        background-color: var(--bg-hover);
        color: var(--text-secondary);
        padding: 1px 8px;
        border-radius: 10px;
        border: 1px solid var(--border-light);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
    }

    /* A hovered row is the chip's own grey, which would leave only its
       outline. */
    .todo:hover .tag-chip {
        background-color: var(--bg-primary);
    }

    /* Finished with the rest of the line. */
    .todo.done .tag-chip {
        color: var(--text-muted);
    }

    /* What the search found, in the sidebar search's highlight, and in the
       colour of the words around it, which is muted on a finished row. No
       padding, which would nudge the letters sideways as marks come and go
       with each key pressed. */
    mark {
        background: var(--accent-bg-hover);
        color: inherit;
        border-radius: 2px;
    }
</style>
