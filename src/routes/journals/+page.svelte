<script lang="ts">
    import { documents } from '$lib/stores/app';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocument, openTag } from '$lib/services/navigation';
    import { loadTagsByDocument } from '$lib/services/tags';
    import { formatJournalTitle, weekdayName } from '$lib/calendar/calendar';
    import { groupByMonth, journalEntries, type JournalEntry } from '$lib/journals/journalIndex';
    import { NO_TAGS, type TagsByDocument } from '$lib/tags/documentTags';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // What each day is tagged with. The only thing on this page that SQL has
    // to answer: a tag lives in the document's content, so the store knows
    // nothing about one, and the derived rows are what make the chips cover
    // days this device has only ever received.
    //
    // Reloaded on every change to any document's derived rows: a tag added
    // here, on another route, renamed, or arriving from a peer while this page
    // is open. One query answers every row.
    let tags = $state<TagsByDocument>(NO_TAGS);

    $effect(() => {
        void $indexRevision;
        let live = true;
        void loadTagsByDocument().then((loaded) => {
            if (live) tags = loaded;
        });
        return () => {
            live = false;
        };
    });

    // Every day the user has a journal for, newest first.
    //
    // The days themselves are read from the document store rather than
    // queried, unlike the todo and tag indexes: a journal's day is its title,
    // which the store already holds for every document, and the store is what
    // the sidebar calendar reads too.
    let entries = $derived(journalEntries($documents, tags));
    let written = $derived(entries.filter((e: JournalEntry) => e.hasContent).length);

    // Clicking a day in the calendar creates that day's journal whether or not
    // anything is written in it, so a month of browsing leaves empty entries
    // behind. They are listed, because they exist and the user made them, but
    // they can be put away.
    let hideEmpty = $state(false);
    let shown = $derived(
        groupByMonth(hideEmpty ? entries.filter((e: JournalEntry) => e.hasContent) : entries),
    );

    // Held in state rather than read at render time, so a page left open
    // overnight stops calling yesterday's entry "Today".
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

    // What a row says about its day, spelled out rather than abbreviated: a
    // column of bare numbers leaves the reader to work out what is being
    // counted, and there are three different things it could be.
    function status(entry: JournalEntry): string {
        if (!entry.hasContent) return 'Nothing written yet';
        if (entry.openTodoCount > 0) {
            return entry.openTodoCount === 1 ? '1 open todo' : `${entry.openTodoCount} open todos`;
        }
        if (entry.todoCount > 0) {
            return entry.todoCount === 1 ? '1 todo, done' : `${entry.todoCount} todos, all done`;
        }
        return '';
    }

    // Opening one is an ordinary navigation to the document, which is what
    // makes the sidebar calendar follow: it highlights whichever journal is
    // open, and moves to that day's month to do it.
    function open(entry: JournalEntry) {
        void openDocument(entry.id);
    }
</script>

<WorkspaceShell title="Journals">
    <div class="journals">
        <div class="journals-bar">
            <p class="summary">
                {entries.length}
                {entries.length === 1
                    ? 'day with a journal'
                    : 'days with a journal'}{#if written < entries.length}, {written}
                    written in{/if}
            </p>
            {#if written < entries.length}
                <label class="filter">
                    <input type="checkbox" bind:checked={hideEmpty} />
                    Hide days with nothing written
                </label>
            {/if}
        </div>

        {#if entries.length === 0}
            <p class="note">
                No journal yet. Pick a day in the calendar, or start writing in today's entry, and
                it will show up here.
            </p>
        {:else if shown.length === 0}
            <p class="note">Nothing written on any of these days yet.</p>
        {:else}
            {#each shown as month (month.key)}
                <section class="month">
                    <h2 class="month-title">{month.label}</h2>
                    <ul class="day-list">
                        {#each month.entries as entry (entry.id)}
                            <li class="day-row" class:empty={!entry.hasContent}>
                                <button
                                    class="day"
                                    onclick={() => open(entry)}
                                    title="Open the journal for {entry.title}"
                                >
                                    <span class="day-name">
                                        {formatJournalTitle(entry.title, today)}
                                    </span>
                                    <span class="day-weekday">{weekdayName(entry.date)}</span>
                                </button>
                                {#if entry.tags.length > 0}
                                    <!-- Each chip is its own button rather than
                                         part of the row, so a tag is a way out
                                         of this page as well as a label on it. -->
                                    <span class="day-tags">
                                        {#each entry.tags as tag (tag)}
                                            <button
                                                class="tag"
                                                onclick={() => openTag(tag)}
                                                title="Everything tagged #{tag}"
                                            >
                                                #{tag}
                                            </button>
                                        {/each}
                                    </span>
                                {/if}
                                <span class="day-status">{status(entry)}</span>
                            </li>
                        {/each}
                    </ul>
                </section>
            {/each}
        {/if}
    </div>
</WorkspaceShell>

<style>
    .journals {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 32px;
    }

    .journals-bar {
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
    }

    .note {
        margin: 24px 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .month {
        margin-top: 20px;
    }

    .month-title {
        margin: 0 0 6px 0;
        font-size: 13px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
    }

    .day-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    /* The row is the container, not the button: the tags in it are buttons of
       their own, and one button cannot hold another. */
    .day-row {
        display: flex;
        align-items: baseline;
        gap: 10px;
        padding: 2px 8px;
        border-radius: 4px;
    }

    .day-row:hover {
        background: var(--bg-hover);
    }

    .day {
        display: flex;
        align-items: baseline;
        gap: 12px;
        flex: 1;
        min-width: 0;
        padding: 7px 0;
        text-align: left;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
    }

    .day-row.empty .day-name {
        color: var(--text-muted);
        font-weight: 400;
    }

    .day-name {
        font-weight: 500;
        min-width: 110px;
    }

    .day-weekday {
        flex: 1;
        font-size: 13px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .day-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        justify-content: flex-end;
        max-width: 50%;
    }

    .tag {
        padding: 1px 7px;
        border: none;
        border-radius: 10px;
        background: var(--accent-bg);
        color: var(--accent-color);
        font-family: inherit;
        font-size: 11px;
        line-height: 1.6;
        cursor: pointer;
        white-space: nowrap;
    }

    .tag:hover {
        text-decoration: underline;
    }

    .day-status {
        flex-shrink: 0;
        min-width: 110px;
        text-align: right;
        font-size: 12px;
        color: var(--text-muted);
    }

    /* On a phone the three columns do not fit beside each other, and sharing
       the width between them cut the date down to "18 Se," and the weekday to
       "M.". The tags take a line of their own instead, under the day they
       belong to. */
    @media (max-width: 640px) {
        .day-row {
            flex-wrap: wrap;
            padding-bottom: 6px;
        }

        .day-tags {
            order: 1;
            flex-basis: 100%;
            max-width: 100%;
            justify-content: flex-start;
        }

        .day-status {
            min-width: 0;
        }
    }
</style>
