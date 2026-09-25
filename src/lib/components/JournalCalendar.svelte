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
    import { dayMarks, type DayMark } from '$lib/calendar/dayMarks';
    import CalendarDay from './CalendarDay.svelte';

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
</script>

<div class="calendar">
    <div class="calendar-header">
        <button
            class="cal-nav-btn"
            onclick={() => (monthOf = addMonths(monthOf, -1))}
            title="Previous month"
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
            >
        </button>
        <div class="cal-center">
            <span class="calendar-title">{monthLabel(monthOf)}</span>
            <button class="today-btn" onclick={goToToday}>Today</button>
        </div>
        <button
            class="cal-nav-btn"
            onclick={() => (monthOf = addMonths(monthOf, 1))}
            title="Next month"
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
            >
        </button>
    </div>
    <div class="calendar-grid">
        {#each DAY_NAMES as d (d)}
            <div class="cal-day-name">{d}</div>
        {/each}
        {#each monthGrid(monthOf) as day, i (i)}
            <CalendarDay
                {day}
                mark={markOf(day)}
                today={isSameDay(monthOf, day, today)}
                selected={isSelected(day)}
                onPick={() => pick(day)}
            />
        {/each}
    </div>
</div>

<style>
    .calendar {
        border: 1px solid var(--border-light);
        border-radius: 8px;
        padding: 8px;
        background: var(--bg-primary);
    }

    .calendar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }

    .calendar-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .cal-center {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }

    .today-btn {
        background: none;
        border: 1px solid var(--border-light);
        cursor: pointer;
        padding: 2px 8px;
        color: var(--text-secondary);
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        transition:
            background 0.1s,
            color 0.1s;
    }

    .today-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .cal-nav-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        color: var(--text-secondary);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .cal-nav-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
    }

    .cal-day-name {
        text-align: center;
        font-size: 10px;
        color: var(--text-muted);
        padding: 2px 0;
        font-weight: 600;
    }
</style>
