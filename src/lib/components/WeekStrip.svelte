<script lang="ts">
    import { addDays, journalTitleFor } from '$lib/calendar/calendar';
    import { dayMarks } from '$lib/calendar/dayMarks';
    import type { DocumentSummary } from '$lib/types';
    import { swipe } from '$lib/gestures/swipe';
    import JournalCalendar from './JournalCalendar.svelte';

    // A phone's way through the days: the week of the open journal, a day to
    // a column, with the dot that says what each holds. Swipe it for the week
    // before or after, and pull its handle down for the whole month.
    interface Props {
        /** The open journal's day. */
        date: Date;
        today: Date;
        journals: DocumentSummary[];
        /** Whether the month is showing in place of the week. */
        expanded?: boolean;
        onPick: (title: string) => void;
    }

    let { date, today, journals, expanded = $bindable(false), onPick }: Props = $props();

    // Weeks away from the open day's week, from swiping the strip.
    let offset = $state(0);
    $effect(() => {
        void date;
        offset = 0;
    });

    let marks = $derived(dayMarks(journals));
    let openTitle = $derived(journalTitleFor(date));
    let todayTitle = $derived(journalTitleFor(today));
    let days = $derived.by(() => {
        const sunday = addDays(date, -date.getDay() + offset * 7);
        return Array.from({ length: 7 }, (_, i) => {
            const day = addDays(sunday, i);
            const title = journalTitleFor(day);
            return {
                title,
                weekday: day.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2),
                number: day.getDate(),
                mark: marks.get(title),
                open: title === openTitle,
                today: title === todayTitle,
            };
        });
    });

    // Pulling the handle down opens the month, and up closes it.
    let pullStart: number | null = null;

    function pullDown(event: TouchEvent) {
        pullStart = event.touches[0].clientY;
    }

    function pullUp(event: TouchEvent) {
        if (pullStart === null) return;
        const dy = event.changedTouches[0].clientY - pullStart;
        pullStart = null;
        if (dy > 30) expanded = true;
        else if (dy < -30) expanded = false;
    }
</script>

<div class="week-strip">
    {#if expanded}
        <div class="month">
            <JournalCalendar
                {journals}
                currentJournalTitle={openTitle}
                {today}
                onPick={(title) => {
                    expanded = false;
                    onPick(title);
                }}
            />
        </div>
    {:else}
        <div
            class="week"
            role="group"
            aria-label="This week"
            use:swipe={{
                onSwipe: (direction) => (offset += direction === 'left' ? 1 : -1),
                options: { distance: 40 },
            }}
        >
            {#each days as day (day.title)}
                <button
                    class="day"
                    class:open={day.open}
                    class:today={day.today}
                    aria-current={day.open ? 'date' : undefined}
                    onclick={() => onPick(day.title)}
                >
                    <small>{day.weekday}</small>
                    <b>{day.number}</b>
                    <i class="dot {day.mark ?? 'none'}"></i>
                </button>
            {/each}
        </div>
    {/if}
    <button
        class="handle"
        aria-label={expanded ? 'Show the week' : 'Show the month'}
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
        ontouchstart={pullDown}
        ontouchend={pullUp}
    >
        <span></span>
    </button>
</div>

<style>
    .week-strip {
        flex-shrink: 0;
        border-bottom: 1px solid var(--border-color);
    }

    .week {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 2px;
        padding: 0 10px;
    }

    .month {
        padding: 0 12px 4px;
    }

    .day {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 4px 0 6px;
        border: none;
        border-radius: 14px;
        background: none;
        color: var(--text-primary);
        -webkit-tap-highlight-color: transparent;
    }

    .day small {
        font-size: 11px;
        font-weight: 550;
        color: var(--text-muted);
    }

    .day b {
        width: 36px;
        height: 36px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        font-size: 16px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .day.today small {
        color: var(--accent-color);
    }

    .day.open b {
        background: var(--btn-primary-bg);
        color: var(--on-accent);
    }

    .day.today:not(.open) b {
        box-shadow: inset 0 0 0 1.5px var(--accent-color);
        color: var(--accent-color);
    }

    .dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--control-line);
    }

    .dot.open-todos {
        background: var(--todo-open);
    }

    .dot.none {
        background: transparent;
    }

    .handle {
        display: flex;
        justify-content: center;
        width: 100%;
        height: 18px;
        padding: 6px 0 8px;
        border: none;
        background: none;
        -webkit-tap-highlight-color: transparent;
    }

    .handle span {
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--border-light);
    }
</style>
