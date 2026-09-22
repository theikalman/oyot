<script lang="ts">
    import { documents } from '$lib/stores/app';
    import { openDocument } from '$lib/services/navigation';
    import { formatJournalTitle, weekdayName } from '$lib/calendar/calendar';
    import { groupByMonth, journalEntries, type JournalEntry } from '$lib/journals/journalIndex';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // Every day the user has a journal for, newest first.
    //
    // Read from the document store rather than queried, unlike the todo and
    // tag indexes: a journal's day is its title, which the store already holds
    // for every document, and the store is what the sidebar calendar reads
    // too. Nothing here needs the content, so nothing here needs SQL.
    let entries = $derived(journalEntries($documents));
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
                {entries.length === 1 ? 'day' : 'days'}{#if written < entries.length}, {written} written{/if}
            </p>
            {#if written < entries.length}
                <label class="filter">
                    <input type="checkbox" bind:checked={hideEmpty} />
                    Hide empty days
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
                            <li>
                                <button
                                    class="day"
                                    class:empty={!entry.hasContent}
                                    onclick={() => open(entry)}
                                    title="Open {entry.title}"
                                >
                                    <span class="day-name">
                                        {formatJournalTitle(entry.title, today)}
                                    </span>
                                    <span class="day-weekday">{weekdayName(entry.date)}</span>
                                    <span class="day-meta">
                                        {#if !entry.hasContent}
                                            Empty
                                        {:else if entry.openTodoCount > 0}
                                            {entry.openTodoCount} open
                                        {:else if entry.todoCount > 0}
                                            All done
                                        {/if}
                                    </span>
                                </button>
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

    .day {
        display: flex;
        align-items: baseline;
        gap: 12px;
        width: 100%;
        padding: 9px 8px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
    }

    .day:hover {
        background: var(--bg-hover);
    }

    .day.empty .day-name {
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

    .day-meta {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
