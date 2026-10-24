<script lang="ts">
    import type { DocumentSummary } from '$lib/types';
    import {
        DAY_NAMES,
        addMonths,
        isSameDay,
        journalDateOf,
        journalTitleForDay,
        monthGrid,
        monthLabel,
    } from '$lib/calendar/calendar';
    import { dayLabel, dayMarks, type DayMark } from '$lib/calendar/dayMarks';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import CalendarDay from './CalendarDay.svelte';
    import Icon from './Icon.svelte';

    interface Props {
        /** Every journal, so a day can show whether it has an entry and a task still to do. */
        journals: DocumentSummary[];
        /** The title of the open journal, if one is open. */
        currentJournalTitle: string | null;
        /** Today, tracked by the parent so it moves at midnight. */
        today: Date;
        onPick: (journalTitle: string) => void;
    }

    let { journals, currentJournalTitle, today, onPick }: Props = $props();

    // The month on display. Local to the calendar: nothing outside it cares
    // which month is being looked at.
    let monthOf = $state(new Date());

    // Follow the open journal into its own month.
    //
    // The grid used to stay on whatever month the calendar was built in, so
    // opening a journal from any other month -- from search, or from the todo
    // index, which lists days going back as far as they were written --
    // highlighted nothing, because the day it opened was not on screen to
    // highlight. Only the title changing moves the grid, so browsing months
    // with the arrows still goes where it is told.
    $effect(() => {
        const date = currentJournalTitle ? journalDateOf(currentJournalTitle) : null;
        if (date) monthOf = new Date(date.getFullYear(), date.getMonth(), 1);
    });

    function pick(day: number | null): void {
        if (day === null) return;
        onPick(journalTitleForDay(monthOf, day));
    }

    function goToToday(): void {
        monthOf = new Date(today);
        onPick(journalTitleForDay(today, today.getDate()));
    }

    // Today's keys, which open its journal from anywhere, named the way the
    // Edit button names its own.
    let todayKeys = $derived(customShortcuts.labelFor('today'));
    let todayHint = $derived(`Today's journal${todayKeys ? ` (${todayKeys})` : ''}`);

    function isSelected(day: number | null): boolean {
        if (day === null || !currentJournalTitle) return false;
        return currentJournalTitle === journalTitleForDay(monthOf, day);
    }

    // Worked out again whenever a journal changes, not for every cell drawn.
    let marks = $derived(dayMarks(journals));

    function markOf(day: number | null): DayMark | undefined {
        if (day === null) return undefined;
        return marks.get(journalTitleForDay(monthOf, day));
    }

    // What a screen reader hears for the day, which the number alone does
    // not tell it: the date, whether it is today, and what the dot means.
    function labelOf(day: number | null, mark: DayMark | undefined, isToday: boolean) {
        if (day === null) return undefined;
        const date = new Date(monthOf.getFullYear(), monthOf.getMonth(), day);
        return dayLabel(date, { mark, today: isToday });
    }
</script>

<div class="calendar">
    <div class="calendar-header">
        <span class="calendar-title">{monthLabel(monthOf)}</span>
        <button class="today-btn" onclick={goToToday} title={todayHint}>Today</button>
        <button
            class="cal-nav-btn"
            onclick={() => (monthOf = addMonths(monthOf, -1))}
            title="Previous month"
            aria-label="Previous month"
        >
            <Icon name="chevron-left" size={16} />
        </button>
        <button
            class="cal-nav-btn"
            onclick={() => (monthOf = addMonths(monthOf, 1))}
            title="Next month"
            aria-label="Next month"
        >
            <Icon name="chevron-right" size={16} />
        </button>
    </div>
    <div class="calendar-grid">
        <!-- Hidden from screen readers, which hear each day's weekday in
             its own label: read out, this row was seven letter pairs
             before the first day. -->
        {#each DAY_NAMES as d (d)}
            <div class="cal-day-name" aria-hidden="true">{d}</div>
        {/each}
        {#each monthGrid(monthOf) as day, i (i)}
            {@const mark = markOf(day)}
            {@const isToday = isSameDay(monthOf, day, today)}
            <CalendarDay
                {day}
                {mark}
                today={isToday}
                selected={isSelected(day)}
                label={labelOf(day, mark, isToday)}
                onPick={() => pick(day)}
            />
        {/each}
    </div>
</div>

<style>
    .calendar {
        padding: 0 2px;
    }

    .calendar-header {
        display: flex;
        align-items: center;
        gap: 2px;
        height: 30px;
        padding-left: 8px;
        margin-bottom: 2px;
    }

    .calendar-title {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .today-btn {
        background: none;
        border: none;
        cursor: pointer;
        height: 24px;
        padding: 0 8px;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 500;
    }

    .today-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .cal-nav-btn {
        width: 26px;
        height: 26px;
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        color: var(--text-secondary);
        border-radius: 7px;
        display: grid;
        place-items: center;
    }

    .cal-nav-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        row-gap: 1px;
    }

    .cal-day-name {
        text-align: center;
        font-size: 11px;
        line-height: 22px;
        color: var(--text-muted);
        font-weight: 500;
    }
</style>
