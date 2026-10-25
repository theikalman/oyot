<script lang="ts">
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocumentAtTodo } from '$lib/services/navigation';
    import { formatJournalTitle, journalTitleFor } from '$lib/calendar/calendar';
    import { createTodoIndex } from '$lib/todos/todoStore.svelte';
    import { countAll, countOpen, type TodoGroup, type TodoHit } from '$lib/todos/grouping';
    import { findTerms, searchSections, searchTerms } from '$lib/todos/todoSearch';
    import { markSegments, todoSegments, type MarkedRun } from '$lib/todos/todoText';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import { tagHueStyle } from '$lib/tags/tagHue';
    import type { Snapshot } from './$types';
    import Icon from '$lib/components/Icon.svelte';
    import { viewport } from '$lib/utils/viewport.svelte';
    import PhoneTodos from './PhoneTodos.svelte';

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

    // Escape empties the box, as it does on the Search page.
    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') query = '';
    }

    // Back from a todo this page opened, it is as it was left: the same
    // search over the same rows, rather than the whole list again and the
    // words to type a second time. SvelteKit keeps this for each entry in
    // the history, so opening the page from the sidebar, which is a new
    // entry, starts afresh.
    export const snapshot: Snapshot<{ query: string; hideCompleted: boolean }> = {
        capture: () => ({ query, hideCompleted }),
        restore: (saved) => {
            query = saved.query;
            hideCompleted = saved.hideCompleted;
        },
    };

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

    // Today's journal is where the eye should land first, so its heading is
    // drawn in the accent colour, as the calendar draws today's cell.
    function isToday(group: TodoGroup): boolean {
        return group.docType === 'journal' && group.title === journalTitleFor(today);
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

    // On a phone the search field waits behind a button in the header.
    let phoneSearch = $state(false);
</script>

<!-- Some of a todo's words, with the ones the search found marked. All on
     one line: a space between two runs would land inside a word. -->
{#snippet marked(runs: MarkedRun[])}{#each runs as run, r (r)}{#if run.match}<mark>{run.text}</mark
            >{:else}{run.text}{/if}{/each}{/snippet}

{#snippet phoneBar()}
    <span class="phone-spacer"></span>
    <button
        class="m-btn"
        onclick={() => (hideCompleted = !hideCompleted)}
        aria-label={hideCompleted ? 'Show done todos' : 'Hide done todos'}
        aria-pressed={!hideCompleted}
    >
        <Icon name={hideCompleted ? 'eye' : 'eye-off'} size={22} />
    </button>
    <button
        class="m-btn"
        class:accent={phoneSearch}
        onclick={() => {
            phoneSearch = !phoneSearch;
            if (!phoneSearch) query = '';
        }}
        aria-label="Find a todo"
        aria-expanded={phoneSearch}
    >
        <Icon name="search" size={22} />
    </button>
{/snippet}

<WorkspaceShell title="Todos" {phoneBar}>
    {#if viewport.phone}
        <div class="phone-todos">
            {#if phoneSearch}
                <label class="phone-search">
                    <Icon name="search" size={16} />
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                        type="search"
                        placeholder="Search todos"
                        bind:value={query}
                        onkeydown={handleSearchKeydown}
                        aria-label="Search todos"
                        autofocus
                    />
                </label>
            {/if}
            {#if todos.failed}
                <p class="note error">
                    Could not read your todos right now. They are still in your notes.
                </p>
            {:else if todos.loading && todos.isEmpty}
                <p class="note">Loading...</p>
            {:else}
                <PhoneTodos
                    {found}
                    {hideCompleted}
                    {searching}
                    openCount={todos.openCount}
                    totalCount={todos.totalCount}
                    {today}
                />
            {/if}
        </div>
    {:else}
        <div class="todos page-body">
            <div class="page-bar">
                <!-- Read out as it changes, so a search says how much it found
                 to someone who cannot see the rows come and go. -->
                <p class="page-summary" aria-live="polite">
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
                <div class="page-actions">
                    {#if !todos.isEmpty}
                        <input
                            class="field-input"
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
                        Only a completed todo matches "{query.trim()}". Untick Hide completed to see
                        it.
                    {:else}
                        Only completed todos match "{query.trim()}". Untick Hide completed to see
                        them.
                    {/if}
                </p>
            {:else if nothingToShow}
                <p class="note">Everything here is done.</p>
            {:else}
                {#each [{ label: 'Journals', groups: journals }, { label: 'Notes', groups: notes }] as section (section.label)}
                    {#if section.groups.length > 0}
                        <section class="section">
                            <h2 class="month-heading">{section.label}</h2>
                            {#each section.groups as group (group.docId)}
                                <div class="group">
                                    <h3 class="group-title" class:today={isToday(group)}>
                                        {heading(group)}
                                    </h3>
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
                                                    <span
                                                        class="box"
                                                        class:checked={todo.checked}
                                                        aria-hidden="true"
                                                    ></span>
                                                    <span class="text" class:empty={!todo.text}>
                                                        {#if todo.text}
                                                            {#each drawn(todo, group) as segment, i (i)}
                                                                {#if segment.kind === 'tag'}
                                                                    <span
                                                                        class="tag-chip"
                                                                        style={tagHueStyle(
                                                                            segment.name,
                                                                        )}
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
    {/if}
</WorkspaceShell>

<style>
    .phone-spacer {
        flex: 1;
    }

    .phone-todos {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        /* Clear of the tab bar floating over the foot of the screen. */
        padding-bottom: 104px;
    }

    .phone-todos .note {
        margin: 24px 20px;
    }

    .phone-search {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        margin: 0 16px 10px;
        padding: 0 12px;
        border-radius: 12px;
        background: var(--bg-secondary);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-muted);
    }

    .phone-search input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: none;
        color: var(--text-primary);
        font-size: 15px;
    }

    .filter {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
    }

    .filter input {
        accent-color: var(--btn-primary-bg);
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
        font-family: var(--font-mono);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
    }

    .section {
        max-width: 860px;
    }

    /* Each day or note is a card of its own, so where one ends is plain. */
    .group {
        margin-top: 12px;
        border-radius: var(--radius-lg);
        background: var(--bg-raised);
        box-shadow: 0 0 0 1px var(--border-color);
        overflow: hidden;
    }

    .group-title {
        margin: 0;
        padding: 12px 16px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        border-bottom: 1px solid var(--border-color);
    }

    .group-title.today {
        color: var(--accent-color);
    }

    .todo-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .todo-list li + li {
        border-top: 1px solid var(--border-color);
    }

    .todo {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        width: 100%;
        padding: 10px 16px;
        text-align: left;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        line-height: 1.5;
    }

    .todo:hover {
        background: var(--bg-hover);
    }

    /* A picture of the editor's tick box. */
    .todo .box {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        margin-top: 1px;
        border-radius: 5px;
        background: var(--bg-raised);
        box-shadow: inset 0 0 0 1.5px var(--control-line);
        position: relative;
    }

    .todo .box.checked {
        background: var(--btn-primary-bg);
        box-shadow: none;
    }

    .todo .box.checked::after {
        content: '';
        position: absolute;
        left: 6px;
        top: 3px;
        width: 5px;
        height: 9px;
        border: solid var(--on-accent);
        border-width: 0 2px 2px 0;
        transform: rotate(45deg);
    }

    .todo.done .text {
        color: var(--text-muted);
        text-decoration: line-through;
        text-decoration-color: var(--control-line);
    }

    .todo .text.empty {
        color: var(--text-muted);
        font-style: italic;
    }

    /* The editor's tag chip (EditorInstance.svelte), so a tag reads here the
       way it does in the note it came from, its # in the tag's own hue. */
    .tag-chip {
        display: inline-block;
        line-height: 20px;
        background-color: var(--code-bg);
        color: var(--text-secondary);
        padding: 1px 8px 1px 7px;
        border-radius: 999px;
        box-shadow: inset 0 0 0 1px var(--border-color);
        font-size: 12.5px;
        font-weight: 500;
        white-space: nowrap;
    }

    .tag-chip::first-letter {
        color: var(--tag-hue, var(--tag-1));
        font-weight: 650;
    }

    /* Finished with the rest of the line. */
    .todo.done .tag-chip {
        color: var(--text-muted);
    }

    /* What the search found, in the Search page's highlight, and in the
       colour of the words around it, which is muted on a finished row. No
       padding, which would nudge the letters sideways as marks come and go
       with each key pressed. */
    mark {
        background: var(--warn-bg);
        color: inherit;
        border-radius: 2px;
    }
</style>
