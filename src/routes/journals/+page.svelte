<script lang="ts">
    import { documents } from '$lib/stores/app';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocument, openTag } from '$lib/services/navigation';
    import { loadTagsByDocument } from '$lib/services/tags';
    import { tick } from 'svelte';
    import { journalTitleFor, monthLabel } from '$lib/calendar/calendar';
    import { openJournal } from '$lib/services/journals';
    import { toasts } from '$lib/services/toast';
    import {
        listRows,
        monthCells,
        shortStatus,
        SHORT_DAYS,
        yearStrip,
        zoomView,
        type DayCell,
        type JournalView,
    } from '$lib/journals/journalViews';
    import { pinch } from '$lib/gestures/pinch';
    import { groupByMonth, journalEntries, type JournalEntry } from '$lib/journals/journalIndex';
    import { NO_TAGS, type TagsByDocument } from '$lib/tags/documentTags';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import TagPill from '$lib/components/TagPill.svelte';
    import Icon from '$lib/components/Icon.svelte';

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

    // Today's entry is where the eye should land first, so its name is drawn
    // in the accent colour, as the calendar and the Todos page draw today.
    let todayTitle = $derived(journalTitleFor(today));

    // Opening one is an ordinary navigation to the document, which is what
    // makes the sidebar calendar follow: it highlights whichever journal is
    // open, and moves to that day's month to do it.
    function open(entry: JournalEntry) {
        void openDocument(entry.id);
    }

    // List, Month or Year. Pinching in on a touch screen, or Ctrl and scroll
    // with a pointer, moves out a step; spreading the fingers moves back in.
    let view = $state<JournalView>('list');

    // The month the Month view shows, and the year the Year view and the strip
    // show. They follow the month and year of whatever was last picked.
    let monthOf = $state(new Date());
    let year = $derived(monthOf.getFullYear());

    function zoom(outward: boolean) {
        view = zoomView(view, outward);
    }

    function handleWheel(event: WheelEvent) {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        if (Math.abs(event.deltaY) < 4) return;
        zoom(event.deltaY > 0);
    }

    function stepMonth(delta: number) {
        monthOf = new Date(monthOf.getFullYear(), monthOf.getMonth() + delta, 1);
    }

    function stepYear(delta: number) {
        monthOf = new Date(monthOf.getFullYear() + delta, monthOf.getMonth(), 1);
    }

    function goToToday() {
        monthOf = new Date(today.getFullYear(), today.getMonth(), 1);
        void openDay(todayTitle);
    }

    async function openDay(title: string | null) {
        if (!title) return;
        try {
            await openJournal(title);
        } catch (error) {
            console.error('[journals] could not open', title, error);
            toasts.error('Could not open that day');
        }
    }

    function openMonth(month: number) {
        monthOf = new Date(year, month, 1);
        view = 'month';
    }

    // A week picked on the year strip: back to the list, at that week's month.
    async function jumpToWeek(week: DayCell[]) {
        const first = week.find((c) => c.title !== null);
        if (!first?.title) return;
        view = 'list';
        await tick();
        const key = first.title.slice(0, 7);
        const heading =
            document.getElementById(`month-${key}`) ??
            [...document.querySelectorAll<HTMLElement>('[id^="month-"]')].find(
                (el) => el.id.slice(6) <= key,
            );
        heading?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    let strip = $derived(yearStrip(year, entries, today));
    let month = $derived(monthCells(monthOf.getFullYear(), monthOf.getMonth(), entries, today));
    let yearMonths = $derived(
        Array.from({ length: 12 }, (_, m) => ({
            month: m,
            label: new Date(year, m, 1).toLocaleDateString(undefined, { month: 'short' }),
            cells: monthCells(year, m, entries, today),
            current: m === today.getMonth() && year === today.getFullYear(),
        })),
    );
    let byTitle = $derived(new Map(entries.map((e: JournalEntry) => [e.title, e])));

    function weekLabel(week: DayCell[]): string {
        const first = week.find((c) => c.title !== null);
        return first?.title ? `Week of ${first.title}` : '';
    }
</script>

{#snippet tagsOf(names: string[])}
    {#each names.slice(0, 2) as tag (tag)}
        <TagPill name={tag} onclick={() => openTag(tag)} />
    {/each}
    {#if names.length > 2}
        <span
            class="tag-pill more"
            title={names
                .slice(2)
                .map((t) => `#${t}`)
                .join(' ')}>+{names.length - 2}</span
        >
    {/if}
{/snippet}

{#snippet statusOf(entry: JournalEntry)}
    {@const said = shortStatus(entry)}
    {#if said}
        <span class="badge {said.tone}">
            {#if said.tone === 'ok'}<Icon name="check" size={12} />{/if}{said.text}
        </span>
    {/if}
{/snippet}

<WorkspaceShell title="Journals">
    <div class="journals page-body" use:pinch={(d) => zoom(d === 'in')} onwheel={handleWheel}>
        <div class="page-bar">
            <p class="page-summary">
                {entries.length}
                {entries.length === 1
                    ? 'day with a journal'
                    : 'days with a journal'}{#if written < entries.length}{` · ${written} written in`}{/if}
            </p>
            <div class="page-actions">
                {#if view === 'list' && written < entries.length}
                    <label class="hide-empty">
                        Hide empty days
                        <button
                            class="switch"
                            class:on={hideEmpty}
                            role="switch"
                            aria-checked={hideEmpty}
                            aria-label="Hide empty days"
                            onclick={() => (hideEmpty = !hideEmpty)}
                        ></button>
                    </label>
                {/if}
                <div class="seg" role="tablist" aria-label="View">
                    {#each [['list', 'List'], ['month', 'Month'], ['year', 'Year']] as [id, label] (id)}
                        <button
                            role="tab"
                            aria-selected={view === id}
                            class:on={view === id}
                            onclick={() => (view = id as JournalView)}>{label}</button
                        >
                    {/each}
                </div>
                <button class="btn" onclick={goToToday}>Today</button>
            </div>
        </div>

        {#if entries.length === 0}
            <p class="note">
                No journal yet. Pick a day in the calendar, or start writing in today's entry, and
                it will show up here.
            </p>
        {:else if view === 'list'}
            <!-- The year at a glance. Click a week to jump to it. -->
            <section class="strip-card" aria-label="The year at a glance">
                <div class="strip-head">
                    <span class="strip-year">{year}</span>
                    <span class="strip-hint">Click a week to jump to it</span>
                    <span class="grow"></span>
                    <span class="legend"><i class="hm"></i>Nothing written</span>
                    <span class="legend"><i class="hm written"></i>Written</span>
                    <span class="legend"><i class="hm open"></i>Open todos</span>
                </div>
                <div class="strip">
                    <div class="strip-days" aria-hidden="true">
                        <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span
                            >Fri</span
                        ><span></span>
                    </div>
                    <div class="strip-body">
                        <div class="strip-months" aria-hidden="true">
                            {#each strip.months as m (m.week)}
                                <span style="left: {m.week * 15}px">{m.label}</span>
                            {/each}
                        </div>
                        <div class="strip-weeks">
                            {#each strip.weeks as week, w (w)}
                                <button
                                    class="week"
                                    onclick={() => jumpToWeek(week)}
                                    title={weekLabel(week)}
                                    aria-label={weekLabel(week)}
                                >
                                    {#each week as cell, d (d)}
                                        <i
                                            class="hm {cell.state}"
                                            class:blank={cell.title === null}
                                            class:today={cell.today}
                                            class:future={cell.future}
                                        ></i>
                                    {/each}
                                </button>
                            {/each}
                        </div>
                    </div>
                </div>
            </section>

            {#if shown.length === 0}
                <p class="note">Nothing written on any of these days yet.</p>
            {/if}
            {#each shown as group (group.key)}
                <section class="month">
                    <h2 class="month-heading" id="month-{group.key}">{group.label}</h2>
                    <ul class="day-list">
                        {#each listRows(group.entries) as row (row.kind === 'day' ? row.entry.id : row.key)}
                            {#if row.kind === 'gap'}
                                <li class="gap">{row.label} · nothing written</li>
                            {:else}
                                {@const entry = row.entry}
                                {@const isToday = entry.title === todayTitle}
                                <li class="day-row" class:today={isToday}>
                                    <button
                                        class="day"
                                        onclick={() => open(entry)}
                                        title="Open the journal for {entry.title}"
                                        aria-current={isToday ? 'date' : undefined}
                                    >
                                        <span class="day-num">{entry.date.getDate()}</span>
                                        <span class="day-name"
                                            >{isToday
                                                ? 'Today'
                                                : entry.date.toLocaleDateString(undefined, {
                                                      weekday: 'short',
                                                  })}</span
                                        >
                                    </button>
                                    <span class="day-tags">{@render tagsOf(entry.tags)}</span>
                                    <span class="day-status">{@render statusOf(entry)}</span>
                                </li>
                            {/if}
                        {/each}
                    </ul>
                </section>
            {/each}
        {:else if view === 'month'}
            <section class="month-view" aria-label={monthLabel(monthOf)}>
                <div class="view-head">
                    <h2>{monthLabel(monthOf)}</h2>
                    <button class="step" onclick={() => stepMonth(-1)} aria-label="Previous month">
                        <Icon name="chevron-left" />
                    </button>
                    <button class="step" onclick={() => stepMonth(1)} aria-label="Next month">
                        <Icon name="chevron-right" />
                    </button>
                </div>
                <div class="month-grid">
                    {#each SHORT_DAYS as name (name)}
                        <span class="weekday" aria-hidden="true">{name}</span>
                    {/each}
                    {#each month as cell, i (i)}
                        {#if cell.title === null}
                            <span class="cell blank"></span>
                        {:else}
                            {@const entry = byTitle.get(cell.title)}
                            <button
                                class="cell {cell.state}"
                                class:today={cell.today}
                                class:future={cell.future}
                                onclick={() => openDay(cell.title)}
                                aria-label={cell.title}
                            >
                                <span class="cell-day">{cell.day}</span>
                                {#if entry}
                                    <span class="cell-body">
                                        {#if entry.tags.length > 0}
                                            <span class="cell-tags"
                                                >{entry.tags
                                                    .slice(0, 2)
                                                    .map((t) => `#${t}`)
                                                    .join(' ')}</span
                                            >
                                        {/if}
                                        {@render statusOf(entry)}
                                    </span>
                                {/if}
                            </button>
                        {/if}
                    {/each}
                </div>
            </section>
        {:else}
            <section class="year-view" aria-label={String(year)}>
                <div class="view-head">
                    <h2>{year}</h2>
                    <button class="step" onclick={() => stepYear(-1)} aria-label="Previous year">
                        <Icon name="chevron-left" />
                    </button>
                    <button class="step" onclick={() => stepYear(1)} aria-label="Next year">
                        <Icon name="chevron-right" />
                    </button>
                </div>
                <div class="year-grid">
                    {#each yearMonths as m (m.month)}
                        <button
                            class="mini"
                            class:current={m.current}
                            onclick={() => openMonth(m.month)}
                            aria-label="Open {m.label}"
                        >
                            <span class="mini-name">{m.label}</span>
                            <span class="mini-grid">
                                {#each m.cells as cell, i (i)}
                                    <i
                                        class="dot {cell.state}"
                                        class:blank={cell.title === null}
                                        class:today={cell.today}
                                        class:future={cell.future}
                                    ></i>
                                {/each}
                            </span>
                        </button>
                    {/each}
                </div>
                <p class="zoom-hint">
                    <span class="pointer-only">Ctrl and scroll</span><span class="touch-only"
                        >Spread two fingers</span
                    > to zoom in. Pick a month to open it.
                </p>
            </section>
        {/if}
    </div>
</WorkspaceShell>

<style>
    .note {
        margin: 24px 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .grow {
        flex: 1;
    }

    .hide-empty {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--text-secondary);
        cursor: pointer;
        margin-right: 4px;
    }

    .switch {
        position: relative;
        width: 36px;
        height: 22px;
        flex-shrink: 0;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: var(--control-line);
        cursor: pointer;
    }

    .switch::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        transition: left 0.15s;
    }

    .switch.on {
        background: var(--btn-primary-bg);
    }

    .switch.on::after {
        left: 17px;
    }

    .seg {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 10px;
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
    }

    .seg button {
        height: 28px;
        padding: 0 12px;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 550;
        cursor: pointer;
    }

    .seg button.on {
        background: var(--bg-raised);
        color: var(--text-primary);
        box-shadow:
            0 0 0 1px var(--border-color),
            0 1px 2px rgba(0, 0, 0, 0.07);
    }

    /* ── The year strip ── */
    .strip-card {
        margin-bottom: 6px;
        padding: 16px 18px 14px;
        border-radius: var(--radius-lg);
        background: var(--bg-raised);
        box-shadow: 0 0 0 1px var(--border-color);
        overflow-x: auto;
    }

    .strip-head {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
        font-size: 12px;
        color: var(--text-muted);
        white-space: nowrap;
    }

    .strip-year {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .legend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 8px;
    }

    .strip {
        display: flex;
        gap: 10px;
    }

    .strip-days {
        display: grid;
        grid-template-rows: 16px repeat(7, 12px);
        row-gap: 3px;
        width: 26px;
        flex-shrink: 0;
        font-size: 10.5px;
        line-height: 12px;
        color: var(--text-muted);
    }

    .strip-days::before {
        content: '';
    }

    .strip-months {
        position: relative;
        height: 16px;
        margin-bottom: 3px;
        font-size: 11px;
        color: var(--text-muted);
    }

    .strip-months span {
        position: absolute;
        top: 0;
    }

    .strip-weeks {
        display: flex;
        gap: 3px;
    }

    .week {
        display: grid;
        grid-template-rows: repeat(7, 12px);
        gap: 3px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: none;
        cursor: pointer;
    }

    .week:hover {
        box-shadow: 0 0 0 2px var(--border-light);
    }

    .hm {
        display: inline-block;
        width: 12px;
        height: 12px;
        border-radius: 3px;
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
    }

    .hm.written,
    .hm.empty {
        background: var(--accent-bg-hover);
        box-shadow: none;
    }

    .hm.written {
        background: color-mix(in srgb, var(--accent-color) 45%, var(--bg-raised));
    }

    .hm.open {
        background: var(--todo-open);
        box-shadow: none;
    }

    .hm.today {
        box-shadow:
            0 0 0 2px var(--bg-raised),
            0 0 0 3.5px var(--accent-color);
    }

    .hm.future {
        opacity: 0.55;
    }

    .hm.blank {
        visibility: hidden;
    }

    /* ── The list ── */
    .month:first-of-type :global(.month-heading) {
        margin-top: 18px;
    }

    .day-list {
        margin: 0 -14px;
        padding: 0;
        list-style: none;
    }

    .day-row {
        display: grid;
        grid-template-columns: 84px minmax(0, 1fr) auto;
        align-items: center;
        gap: 16px;
        min-height: 54px;
        padding: 4px 14px;
        border-radius: 12px;
    }

    .day-row:hover {
        background: var(--bg-hover);
    }

    .day-row.today {
        background: var(--accent-bg);
        box-shadow: inset 0 0 0 1px var(--accent-color);
    }

    .day {
        display: flex;
        align-items: baseline;
        gap: 6px;
        padding: 10px 0;
        border: none;
        background: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
    }

    .day-num {
        width: 28px;
        font-size: 20px;
        line-height: 24px;
        font-weight: 650;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
    }

    .day-name {
        font-size: 12px;
        font-weight: 550;
        color: var(--text-muted);
    }

    .day-row.today .day-num,
    .day-row.today .day-name {
        color: var(--accent-color);
    }

    .day-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow: hidden;
    }

    .more {
        color: var(--text-muted);
    }

    .day-status {
        display: flex;
        justify-content: flex-end;
    }

    .gap {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 30px;
        padding: 0 14px 0 30px;
        font-size: 12.5px;
        color: var(--text-muted);
    }

    .gap::before {
        content: '';
        width: 44px;
        flex-shrink: 0;
        border-top: 1px dashed var(--border-light);
    }

    /* ── Month and year ── */
    .view-head {
        display: flex;
        align-items: center;
        gap: 4px;
        margin: 8px 0 12px;
    }

    .view-head h2 {
        flex: 1;
        margin: 0;
        font-size: 20px;
        font-weight: 620;
        letter-spacing: -0.015em;
    }

    .step {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .step:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .month-grid {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 6px;
        max-width: 980px;
    }

    .weekday {
        padding: 0 8px 4px;
        font-size: 12px;
        font-weight: 550;
        color: var(--text-muted);
    }

    .cell {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        min-height: 92px;
        padding: 8px;
        border: none;
        border-radius: var(--radius-lg);
        background: var(--code-bg);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        min-width: 0;
    }

    .cell:hover {
        box-shadow: inset 0 0 0 1px var(--border-light);
        background: var(--bg-hover);
    }

    .cell.blank {
        background: none;
        box-shadow: none;
    }

    .cell.written,
    .cell.open,
    .cell.empty {
        background: var(--bg-raised);
    }

    .cell.future {
        opacity: 0.6;
    }

    .cell.today {
        box-shadow: inset 0 0 0 2px var(--accent-color);
    }

    .cell-day {
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .cell.today .cell-day {
        color: var(--accent-color);
    }

    .cell-body {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
    }

    .cell-tags {
        max-width: 100%;
        font-size: 11.5px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .year-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        max-width: 980px;
    }

    .mini {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border: none;
        border-radius: 14px;
        background: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
    }

    .mini:hover {
        background: var(--bg-hover);
    }

    .mini.current {
        background: var(--accent-bg);
        box-shadow: inset 0 0 0 1px var(--accent-color);
    }

    .mini-name {
        font-size: 13px;
        font-weight: 600;
    }

    .mini.current .mini-name {
        color: var(--accent-color);
    }

    .mini-grid {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        row-gap: 5px;
        justify-items: center;
    }

    .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--border-color);
    }

    .dot.written,
    .dot.empty {
        background: var(--control-line);
    }

    .dot.open {
        background: var(--todo-open);
    }

    .dot.today {
        background: var(--accent-color);
        box-shadow: 0 0 0 2px var(--accent-bg-hover);
    }

    .dot.future {
        background: transparent;
        box-shadow: inset 0 0 0 1px var(--border-color);
    }

    .dot.blank {
        visibility: hidden;
    }

    .zoom-hint {
        margin: 18px 0 0;
        font-size: 12.5px;
        color: var(--text-muted);
    }

    .touch-only {
        display: none;
    }

    @media (pointer: coarse) {
        .touch-only {
            display: inline;
        }

        .pointer-only {
            display: none;
        }
    }

    /* A tablet still has room for the strip; a phone has the Year view. */
    @media (max-width: 700px) {
        .strip-card {
            display: none;
        }

        .page-actions {
            width: 100%;
        }

        .seg {
            flex: 1;
        }

        .seg button {
            flex: 1;
            height: 34px;
        }

        .hide-empty {
            order: 3;
        }

        .day-row {
            grid-template-columns: 70px minmax(0, 1fr) auto;
            gap: 10px;
        }

        .day-tags {
            display: none;
        }

        .month-grid {
            gap: 3px;
        }

        .cell {
            min-height: 52px;
            padding: 6px;
            border-radius: var(--radius-md);
        }

        .cell-body {
            display: none;
        }

        .year-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 4px;
        }

        .mini {
            padding: 8px;
        }

        .dot {
            width: 7px;
            height: 7px;
        }
    }
</style>
