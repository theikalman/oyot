<script lang="ts">
    import { openDocumentAtTodo } from '$lib/services/navigation';
    import { documentRepository } from '$lib/sync/client';
    import { toggleTodoInDoc } from '$lib/mcp/todos';
    import { toasts } from '$lib/services/toast';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { formatJournalTitle, journalTitleFor, longJournalTitle } from '$lib/calendar/calendar';
    import type { TodoGroup, TodoHit, TodoSections } from '$lib/todos/grouping';
    import { todoSegments } from '$lib/todos/todoText';
    import { tagHueStyle } from '$lib/tags/tagHue';
    import SwipeRow from '$lib/components/SwipeRow.svelte';
    import Icon from '$lib/components/Icon.svelte';

    // The Todos page on a phone: a large title, the tags to narrow it by,
    // then each day's and each note's todos under its heading. Tap a box or
    // swipe a row right to tick it; swipe left for where it lives.
    interface Props {
        /** What the search found, finished todos included. */
        found: TodoSections;
        hideCompleted: boolean;
        searching: boolean;
        openCount: number;
        totalCount: number;
        today: Date;
    }

    let { found, hideCompleted, searching, openCount, totalCount, today }: Props = $props();

    // Ticks made here, shown at once rather than after the index catches up,
    // which it does on the next revision.
    let ticked = $state<Record<string, boolean>>({});
    $effect(() => {
        void $indexRevision;
        ticked = {};
    });

    const key = (todo: TodoHit) => `${todo.document_id}:${todo.ordinal}`;
    const isChecked = (todo: TodoHit) => ticked[key(todo)] ?? todo.checked;

    function tagsIn(todo: TodoHit, group: TodoGroup): string[] {
        return todoSegments(todo.text, group.tags).flatMap((s) =>
            s.kind === 'tag' ? [s.name] : [],
        );
    }

    // The tags the open todos carry, most used first, to narrow the list by.
    let tagChips = $derived.by(() => {
        const counts: Record<string, number> = {};
        for (const group of [...found.journals, ...found.notes]) {
            for (const todo of group.todos) {
                if (todo.checked) continue;
                for (const tag of new Set(tagsIn(todo, group)))
                    counts[tag] = (counts[tag] ?? 0) + 1;
            }
        }
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 12)
            .map(([tag]) => tag);
    });

    let tag = $state<string | null>(null);

    function visible(group: TodoGroup): TodoHit[] {
        return group.todos.filter(
            (todo) =>
                !(hideCompleted && todo.checked) && (!tag || tagsIn(todo, group).includes(tag)),
        );
    }

    let groups = $derived(
        [...found.journals, ...found.notes]
            .map((group) => ({ group, todos: visible(group) }))
            .filter((shown) => shown.todos.length > 0),
    );

    let todayTitle = $derived(journalTitleFor(today));

    function heading(group: TodoGroup): { lead: string | null; rest: string } {
        if (group.docType !== 'journal') return { lead: null, rest: group.title };
        const short = formatJournalTitle(group.title, today);
        const long = (longJournalTitle(group.title) ?? group.title).replace(
            ` ${today.getFullYear()}`,
            '',
        );
        return short === 'Today' || short === 'Yesterday'
            ? { lead: short, rest: long }
            : { lead: null, rest: long };
    }

    async function tick(todo: TodoHit, checked: boolean) {
        ticked[key(todo)] = checked;
        try {
            const outcome = await documentRepository.editDocument(todo.document_id, (ydoc) =>
                toggleTodoInDoc(ydoc, todo.ordinal, todo.text, checked),
            );
            if (outcome === 'moved') {
                delete ticked[key(todo)];
                toasts.error('That todo has changed since. Open it to tick it there.');
            }
        } catch (error) {
            console.error('[todos] could not tick a todo:', error);
            delete ticked[key(todo)];
            toasts.error('Could not tick that todo');
        }
    }

    function open(todo: TodoHit) {
        void openDocumentAtTodo(todo.document_id, todo.ordinal);
    }
</script>

<div class="m-head">
    <h1 class="m-title">Todos</h1>
    <p class="m-sub" aria-live="polite">
        {#if searching}
            {groups.reduce((n, g) => n + g.todos.filter((t) => !t.checked).length, 0)} open matching
        {:else}
            {openCount} open of {totalCount}
        {/if}
    </p>
</div>

{#if tagChips.length > 0}
    <div class="chips" role="group" aria-label="Filter by tag">
        <button class="chip" class:on={tag === null} onclick={() => (tag = null)}>All</button>
        {#each tagChips as name (name)}
            <button
                class="chip"
                class:on={tag === name}
                style={tagHueStyle(name)}
                aria-pressed={tag === name}
                onclick={() => (tag = tag === name ? null : name)}><b>#</b>{name}</button
            >
        {/each}
    </div>
{/if}

{#if groups.length === 0}
    <p class="empty-note">
        {searching || tag ? 'No open todo matches.' : 'Everything here is done.'}
    </p>
{/if}

{#each groups as { group, todos } (group.docId)}
    {@const head = heading(group)}
    {@const openHere = todos.filter((t) => !isChecked(t)).length}
    <section>
        <h2 class="m-section group-head">
            {#if head.lead}
                <span class:accent={group.title === todayTitle}>{head.lead}</span>
            {/if}
            <span class="rest" class:lead={!head.lead}>{head.rest}</span>
            <span class="grow"></span>
            {#if openHere > 0}
                <span class="badge todo">{openHere} open</span>
            {/if}
        </h2>
        <ul class="rows">
            {#each todos as todo (todo.ordinal)}
                {@const checked = isChecked(todo)}
                <li>
                    <SwipeRow actionsWidth={96} onSwipeRight={() => tick(todo, !checked)}>
                        {#snippet rightLabel()}
                            <Icon name="check" size={20} />{checked ? 'Not done' : 'Done'}
                        {/snippet}
                        {#snippet actions()}
                            <button class="where" onclick={() => open(todo)}>
                                <Icon name={group.docType === 'journal' ? 'journals' : 'note'} />
                                {group.docType === 'journal' ? 'In journal' : 'In note'}
                            </button>
                        {/snippet}
                        <div class="row" style="padding-left: {20 + todo.depth * 22}px">
                            <button
                                class="box"
                                class:checked
                                role="checkbox"
                                aria-checked={checked}
                                aria-label={checked ? 'Mark as not done' : 'Mark as done'}
                                onclick={() => tick(todo, !checked)}
                            >
                                {#if checked}<Icon name="check" size={14} />{/if}
                            </button>
                            <button class="text" class:done={checked} onclick={() => open(todo)}>
                                {#each todoSegments(todo.text, group.tags) as segment, i (i)}
                                    {#if segment.kind === 'tag'}
                                        <span class="tag-chip" style={tagHueStyle(segment.name)}
                                            ><b>#</b>{segment.name}</span
                                        >
                                    {:else}
                                        {segment.text}
                                    {/if}
                                {:else}
                                    <em>Empty item</em>
                                {/each}
                            </button>
                        </div>
                    </SwipeRow>
                </li>
            {/each}
        </ul>
    </section>
{/each}

<style>
    .chips {
        display: flex;
        gap: 8px;
        padding: 0 16px 6px;
        overflow-x: auto;
        scrollbar-width: none;
    }

    .chip {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: 34px;
        padding: 0 13px;
        border: none;
        border-radius: 999px;
        background: var(--bg-secondary);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 550;
    }

    .chip b {
        color: var(--tag-hue, var(--tag-1));
        font-weight: 700;
    }

    .chip.on {
        background: var(--btn-primary-bg);
        color: var(--on-accent);
        box-shadow: none;
    }

    .chip.on b {
        color: inherit;
    }

    .group-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
    }

    .group-head .accent {
        color: var(--accent-color);
    }

    .group-head .rest {
        font-weight: 500;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .group-head .rest.lead {
        font-weight: 600;
    }

    .grow {
        flex: 1;
    }

    .rows {
        margin: 0;
        padding: 0;
        list-style: none;
        border-top: 1px solid var(--border-color);
        border-bottom: 1px solid var(--border-color);
    }

    .rows li + li {
        border-top: 1px solid var(--border-color);
    }

    .row {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        min-height: 58px;
        padding: 13px 20px;
    }

    .box {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        margin-top: 1px;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: 7px;
        background: var(--bg-raised);
        box-shadow: inset 0 0 0 1.5px var(--control-line);
        color: var(--on-accent);
        -webkit-tap-highlight-color: transparent;
    }

    /* A bigger target than it looks, for a thumb. */
    .box::before {
        content: '';
        position: absolute;
        width: 44px;
        height: 44px;
    }

    .box.checked {
        background: var(--btn-primary-bg);
        box-shadow: none;
    }

    .text {
        flex: 1;
        min-width: 0;
        padding: 0;
        border: none;
        background: none;
        text-align: left;
        color: var(--text-primary);
        font-size: 16px;
        line-height: 23px;
        -webkit-tap-highlight-color: transparent;
    }

    .text.done {
        color: var(--text-muted);
        text-decoration: line-through;
        text-decoration-color: var(--control-line);
    }

    .text em {
        color: var(--text-muted);
    }

    .tag-chip {
        display: inline-block;
        height: 20px;
        line-height: 20px;
        padding: 0 7px 0 6px;
        border-radius: 999px;
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-secondary);
        font-size: 11.5px;
        font-weight: 500;
        vertical-align: 1px;
    }

    .tag-chip b {
        color: var(--tag-hue, var(--tag-1));
        font-weight: 650;
    }

    .where {
        width: 96px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border: none;
        background: var(--btn-primary-bg);
        color: var(--on-accent);
        font-size: 12px;
        font-weight: 600;
    }

    .empty-note {
        margin: 24px 20px;
        font-size: 14px;
        line-height: 1.6;
        color: var(--text-muted);
    }
</style>
