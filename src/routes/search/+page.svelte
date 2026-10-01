<script lang="ts">
    import { tick } from 'svelte';
    import { afterNavigate } from '$app/navigation';
    import { documents } from '$lib/stores/app';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocument, openDocumentAtTodo } from '$lib/services/navigation';
    import { formatJournalTitle, journalTitleFor } from '$lib/calendar/calendar';
    import { createSearch } from '$lib/search/searchStore.svelte';
    import { createTodoIndex } from '$lib/todos/todoStore.svelte';
    import { createDocumentTags } from '$lib/tags/tagStore.svelte';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { searchTerms } from '$lib/todos/todoSearch';
    import {
        SCOPES,
        documentTypeFor,
        isScope,
        isTextScope,
        scopeInfo,
        type SearchScope,
    } from '$lib/search/scopes';
    import {
        documentResults,
        taggedResults,
        tagTerms,
        todoResults,
        type SearchResult,
    } from '$lib/search/results';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import type { Snapshot } from './$types';

    // Every way of finding something, on one page: the words in every note
    // and journal, or in the notes alone, the journals alone, the todos, or
    // the tags. Each is answered where its rows already are (see
    // $lib/search/results), and listed the same way, a row that opens what it
    // names.

    let query = $state('');
    let scope = $state<SearchScope>('all');
    let info = $derived(scopeInfo(scope));

    // A touch screen's keyboard covers half of it, so some of what suits a
    // keyboard is left out there. Asked once: a device does not change.
    const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

    // Titles and text, from the full-text index, the one search that has to
    // ask Rust as the user types. Asked again whenever any document's indexed
    // words change, here or arriving from a peer, so a hit never names a
    // note that has been deleted since.
    const search = createSearch();

    $effect(() => {
        void $indexRevision;
        if (!isTextScope(scope)) {
            search.clear();
            return;
        }
        return search.schedule(query.trim(), documentTypeFor(scope));
    });

    // Todos and tags are filtered here, as the Todos and Notes pages filter
    // theirs: every row is already in hand once read. Read when they are
    // the choice, and again on every change to the derived rows.
    const todos = createTodoIndex();
    const documentTags = createDocumentTags();

    $effect(() => {
        void $indexRevision;
        if (scope === 'todos') void todos.load();
    });

    $effect(() => {
        void $indexRevision;
        if (scope === 'tags') void documentTags.load();
    });

    // What there is to look for. A hash on its own is nothing yet to a
    // search by tag.
    let asked = $derived((scope === 'tags' ? tagTerms(query) : searchTerms(query)).length > 0);

    let results = $derived.by((): SearchResult[] => {
        if (scope === 'todos') return todoResults(todos.sections, searchTerms(query));
        if (scope === 'tags') return taggedResults($documents, documentTags.tags, tagTerms(query));
        return documentResults(search.results);
    });

    // Where the answer is. Rows already found stay up while the next answer
    // is on its way, so the list does not blink at every key.
    let status = $derived.by((): 'idle' | 'loading' | 'failed' | 'ready' => {
        if (!asked) return 'idle';
        if (scope === 'todos') {
            if (todos.failed) return 'failed';
            return todos.loading && todos.isEmpty ? 'loading' : 'ready';
        }
        if (scope === 'tags') {
            if (documentTags.failed) return 'failed';
            return documentTags.loading && documentTags.tags.size === 0 ? 'loading' : 'ready';
        }
        if (search.failed) return 'failed';
        return search.searching && search.results.length === 0 ? 'loading' : 'ready';
    });

    let summary = $derived.by(() => {
        if (status === 'loading') return 'Searching...';
        if (status !== 'ready' || results.length === 0) return '';
        const count = results.length;
        if (isTextScope(scope) && search.more) {
            return `More than ${count} results, the best first. Another word narrows them down.`;
        }
        return `${count} ${count === 1 ? 'result' : 'results'}`;
    });

    // The kind of each document is worth a word only where the rows mix
    // them.
    let showKind = $derived(scope === 'all' || scope === 'todos' || scope === 'tags');

    // ── The keyboard ──
    //
    // The arrow keys move through the rows and Enter opens one, so a search
    // can be finished without leaving the keyboard. Which row they are on is
    // held by its key, not its place, so rows read afresh keep it.

    let scroller = $state<HTMLDivElement | null>(null);
    let box = $state<HTMLInputElement | null>(null);
    let list = $state<HTMLUListElement | null>(null);
    // The box and the choices stay at the top while the rows scroll under
    // them, so a row brought into view has to clear them.
    let barHeight = $state(0);
    let boxFocused = $state(false);
    let selectedKey = $state<string | null>(null);
    // Whether the arrow keys have been used on these rows, which on a touch
    // screen is a keyboard attached.
    let arrowed = $state(false);

    let selectedIndex = $derived(
        Math.max(
            results.findIndex((result) => result.key === selectedKey),
            0,
        ),
    );

    // The row Enter opens, outlined while the box has the keys. On a touch
    // screen Enter is the keyboard's search key, which opens nothing, so
    // nothing is outlined there until the arrow keys are used.
    let showSelection = $derived(boxFocused && (!touch || arrowed));

    // New words or a new choice are new rows: back to the first, and to the
    // top. Left where it was, a list shorter than the last would open at its
    // end.
    function restart() {
        selectedKey = null;
        arrowed = false;
        scroller?.scrollTo({ top: 0 });
    }

    function move(delta: number) {
        const count = results.length;
        selectedKey = results[(selectedIndex + delta + count) % count].key;
        arrowed = true;
        void tick().then(() => reveal('nearest'));
    }

    function reveal(block: 'nearest' | 'center') {
        list?.children[selectedIndex]?.scrollIntoView({ block });
    }

    function handleKeydown(event: KeyboardEvent) {
        // Still choosing a word in an input method; the keys are its.
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            query = '';
            restart();
            return;
        }
        if (results.length === 0) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            // The search key of a touch screen's keyboard means "done
            // typing": put the keyboard away so the rows can be seen.
            if (touch && !arrowed) {
                box?.blur();
                return;
            }
            open(results[selectedIndex]);
        }
    }

    // A choice made with the pointer sends the keys back to the box, so the
    // words can be changed straight away. One made with the keyboard leaves
    // them on the choices, where the arrow keys are moving between them, and
    // a touch screen is left alone, where the box would bring the keyboard
    // back up over the rows.
    function handleScopeChange(event: Event) {
        restart();
        const choice = event.currentTarget as HTMLInputElement;
        if (!touch && !choice.matches(':focus-visible')) box?.focus();
    }

    // The row opened is the one the keys are on when the page comes back.
    function open(result: SearchResult) {
        selectedKey = result.key;
        if (result.kind === 'todo') void openDocumentAtTodo(result.docId, result.ordinal);
        else void openDocument(result.docId);
    }

    // Opening Search puts the cursor in the box. Coming back to it does too,
    // so the arrow keys carry on from the row that was opened, except on a
    // touch screen, where the keyboard would cover the rows that were left.
    afterNavigate(({ type }) => {
        if (type === 'popstate' && touch) return;
        box?.focus();
    });

    // So do Search's own keys, pressed here, where the layout has nowhere to
    // take them, with the words chosen so the next ones typed replace them.
    // Not under a dialog, which keeps the keys while it is up.
    function handleWindowKeydown(event: KeyboardEvent) {
        if (!customShortcuts.matches('search', event)) return;
        if (document.querySelector('[aria-modal="true"]')) return;
        event.preventDefault();
        box?.focus();
        box?.select();
    }

    // Back from a row this page opened, it is as it was left: the same words,
    // the same choice, and the row that was opened, scrolled to once it is
    // listed again. SvelteKit keeps this for each entry in the history, so
    // opening the page from the sidebar, a new entry, starts afresh.
    let revealing = $state(false);

    export const snapshot: Snapshot<{ query: string; scope: string; selected: string | null }> = {
        capture: () => ({ query, scope, selected: selectedKey }),
        restore: (saved) => {
            query = typeof saved.query === 'string' ? saved.query : '';
            scope = isScope(saved.scope) ? saved.scope : 'all';
            selectedKey = typeof saved.selected === 'string' ? saved.selected : null;
            revealing = selectedKey !== null;
        },
    };

    $effect(() => {
        if (!revealing || status !== 'ready') return;
        revealing = false;
        if (results.some((result) => result.key === selectedKey)) {
            void tick().then(() => reveal('center'));
        }
    });

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

    // A journal by its day, as the Todos page heads one, and today's in the
    // accent colour, as everywhere a day is listed.
    function heading(result: SearchResult): string {
        return result.docType === 'journal'
            ? formatJournalTitle(result.title, today)
            : result.title;
    }

    function isToday(result: SearchResult): boolean {
        return result.docType === 'journal' && result.title === journalTitleFor(today);
    }

    function kindLabel(result: SearchResult): string {
        return result.docType === 'journal' ? 'Journal' : 'Note';
    }
</script>

<!-- Some words, with what the search found marked. All on one line: a space
     between two runs would land inside a word. -->
{#snippet marked(
    runs: { text: string; match: boolean }[],
)}{#each runs as run, r (r)}{#if run.match}<mark>{run.text}</mark
            >{:else}{run.text}{/if}{/each}{/snippet}

<svelte:window onkeydown={handleWindowKeydown} />

<WorkspaceShell title="Search">
    <div class="search-page" bind:this={scroller}>
        <div class="search-bar" bind:clientHeight={barHeight}>
            <div class="box-wrap">
                <svg
                    class="box-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                    bind:this={box}
                    bind:value={query}
                    class="search-box"
                    type="search"
                    placeholder={info.placeholder}
                    aria-label={info.placeholder}
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    enterkeyhint="search"
                    oninput={restart}
                    onkeydown={handleKeydown}
                    onfocus={() => (boxFocused = true)}
                    onblur={() => (boxFocused = false)}
                />
            </div>

            <div class="scopes" role="radiogroup" aria-label="What to search">
                {#each SCOPES as option (option.id)}
                    <label class="scope" class:active={scope === option.id}>
                        <input
                            type="radio"
                            name="search-scope"
                            value={option.id}
                            bind:group={scope}
                            onchange={handleScopeChange}
                        />
                        {option.label}
                    </label>
                {/each}
            </div>

            <!-- Read out as it changes, so a search says how much it found
                 to someone who cannot see the rows come and go. -->
            <p class="summary" aria-live="polite">{summary}</p>
        </div>

        {#if status === 'idle'}
            <p class="note">{info.hint}</p>
        {:else if status === 'failed'}
            <p class="note error">{info.failure}</p>
        {:else if status === 'ready' && results.length === 0}
            <p class="note">No {info.noun} matches "{query.trim()}".</p>
        {:else if results.length > 0}
            <ul class="results" bind:this={list} style:--bar-height="{barHeight}px">
                {#each results as result, i (result.key)}
                    <li>
                        <button
                            class="result"
                            class:selected={showSelection && i === selectedIndex}
                            onclick={() => open(result)}
                        >
                            <span class="result-head">
                                {#if result.kind === 'todo'}
                                    <!-- A picture of the checkbox, not the
                                         checkbox: this page opens the note,
                                         it does not edit it. -->
                                    <span class="box" aria-hidden="true">
                                        {result.checked ? '☑' : '☐'}
                                    </span>
                                    <span
                                        class="result-title todo-text"
                                        class:done={result.checked}
                                    >
                                        {#each result.text as segment, s (s)}
                                            {#if segment.kind === 'tag'}
                                                <span class="tag-chip"
                                                    >{@render marked(segment.runs)}</span
                                                >
                                            {:else}
                                                {@render marked(segment.runs)}
                                            {/if}
                                        {/each}
                                    </span>
                                {:else}
                                    <span class="result-title" class:today={isToday(result)}>
                                        <!-- A journal's stored title is its
                                             date, which its day stands for,
                                             so there is nothing to mark in
                                             what is shown. -->
                                        {#if result.kind === 'document' && result.docType !== 'journal'}
                                            {@render marked(result.titleParts)}
                                        {:else}
                                            {heading(result)}
                                        {/if}
                                    </span>
                                {/if}
                                {#if showKind}
                                    <span class="result-kind">{kindLabel(result)}</span>
                                {/if}
                            </span>

                            {#if result.kind === 'todo'}
                                <span class="result-where" class:today={isToday(result)}>
                                    {heading(result)}
                                </span>
                            {:else if result.kind === 'document'}
                                {#if result.snippet.length > 0}
                                    <span class="result-snippet">
                                        {@render marked(result.snippet)}
                                    </span>
                                {/if}
                            {:else}
                                <span class="result-tags">
                                    {#each result.tags as tag (tag.name)}
                                        <span class="tag-chip">{@render marked(tag.runs)}</span>
                                    {/each}
                                </span>
                            {/if}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</WorkspaceShell>

<style>
    .search-page {
        flex: 1;
        overflow-y: auto;
        padding: 0 24px 32px;
    }

    /* Held at the top while the rows scroll under it, so what was typed is
       in sight while the arrow keys go down a long list. Its top padding is
       the page's, which a sticky bar could not stick inside. */
    .search-bar {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 16px 0 4px;
        background: var(--bg-primary);
    }

    .box-wrap {
        position: relative;
    }

    .box-icon {
        position: absolute;
        top: 50%;
        left: 11px;
        transform: translateY(-50%);
        color: var(--text-muted);
        pointer-events: none;
    }

    .search-box {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 12px 8px 34px;
        font-size: 15px;
        font-family: inherit;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
    }

    .search-box::placeholder {
        color: var(--text-muted);
    }

    .search-box:focus {
        outline: none;
        border-color: var(--accent-color);
    }

    .scopes {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    /* The help page's contents pills, lit like the sidebar's open page. */
    .scope {
        position: relative;
        padding: 4px 12px;
        border: 1px solid var(--border-light);
        border-radius: 14px;
        color: var(--text-secondary);
        font-size: 13px;
        line-height: 1.4;
        cursor: pointer;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
    }

    /* The radio is what the keyboard and a screen reader use; the pill is
       what is seen. */
    .scope input {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: 0;
        opacity: 0;
        pointer-events: none;
    }

    .scope:has(input:focus-visible) {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }

    @media (hover: hover) {
        .scope:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
    }

    .scope.active,
    .scope.active:hover {
        background: var(--accent-bg);
        border-color: var(--accent-color);
        color: var(--accent-color);
    }

    .summary {
        min-height: 20px;
        margin: 0;
        font-size: 13px;
        line-height: 20px;
        color: var(--text-secondary);
    }

    .note {
        margin: 16px 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .note.error {
        color: var(--status-error);
    }

    .results {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    /* A row the arrow keys bring into view stops below the bar, not under
       it. */
    .results > li {
        scroll-margin-top: calc(var(--bar-height, 0px) + 4px);
        scroll-margin-bottom: 4px;
    }

    .result {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        padding: 8px 10px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        color: var(--text-primary);
        font-family: inherit;
    }

    .result:hover {
        background: var(--bg-hover);
    }

    .result.selected {
        background: var(--bg-hover);
        outline: 2px solid var(--accent-color);
        outline-offset: -2px;
    }

    .result-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        width: 100%;
        min-width: 0;
    }

    .result-title {
        flex: 1;
        min-width: 0;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.5;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .result-title.today,
    .result-where.today {
        color: var(--accent-color);
    }

    /* A task's words are what it is, so they wrap rather than being cut
       short, as they do on the Todos page. */
    .result-title.todo-text {
        font-weight: 400;
        white-space: normal;
    }

    .result-title.todo-text.done {
        color: var(--text-muted);
        text-decoration: line-through;
    }

    .box {
        flex-shrink: 0;
        font-size: 14px;
        color: var(--text-secondary);
    }

    .result-kind {
        flex-shrink: 0;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
    }

    .result-snippet {
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    .result-where {
        font-size: 12px;
        color: var(--text-muted);
    }

    /* Under the checkbox's picture, in line with the task's words. */
    .result-head:has(.box) + .result-where {
        padding-left: 22px;
    }

    .result-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 2px;
    }

    /* The editor's tag chip (EditorInstance.svelte), as the Todos page draws
       one, so a tag reads here the way it does in the note it came from. */
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
    .result:hover .tag-chip,
    .result.selected .tag-chip {
        background-color: var(--bg-primary);
    }

    .todo-text.done .tag-chip {
        color: var(--text-muted);
    }

    /* What the search found, in the Todos page's highlight, and in the
       colour of the words around it. No padding, which would nudge the
       letters sideways as marks come and go with each key pressed. */
    mark {
        background: var(--accent-bg-hover);
        color: inherit;
        border-radius: 2px;
    }

    /* Sized for a finger: a pill is about 26px high, and what a tap can land
       on reaches 44px into the gaps around it, without the pill looking any
       bigger. The box's text is 16px, below which iOS zooms the page in on
       a field as it is tapped. */
    @media (pointer: coarse) {
        .scope::after {
            content: '';
            position: absolute;
            inset: -9px -4px;
        }

        .search-box {
            font-size: 16px;
        }
    }

    @media (max-width: 640px) {
        .search-page {
            padding: 0 16px 24px;
        }

        .search-bar {
            padding-top: 12px;
        }
    }
</style>
