<script lang="ts">
    import { MARK_MEANINGS, type DayMark } from '$lib/calendar/dayMarks';

    // One day of the journal calendar: its number, the dot that says what
    // the day holds, and whether it is today or the day open.
    //
    // On its own so the help page can draw a day the way the calendar does,
    // to say what the colours mean. A copy of these styles there would go on
    // showing the old dot the first time this one changed.
    interface Props {
        /** The day of the month. Null for a blank square outside the month. */
        day: number | null;
        mark?: DayMark;
        today?: boolean;
        /** The day whose journal is open. */
        selected?: boolean;
        /**
         * What a screen reader calls the day, from `dayLabel`: its date and
         * what it holds. Only for a day that can be pressed.
         */
        label?: string;
        /**
         * Opens the day. Left out, the day is only a picture of one, the way
         * the help page shows it, with nothing about it to press.
         */
        onPick?: () => void;
    }

    let { day, mark, today = false, selected = false, label, onPick }: Props = $props();
</script>

{#snippet face()}
    {#if mark}
        <span class="journal-dot" class:open-todos={mark === 'open-todos'}></span>
    {/if}
    {day ?? ''}
{/snippet}

{#if onPick}
    <!-- The dot says what the day holds only in colour. Hovering the day
         says it in words, and a screen reader hears the date and the same
         words rather than the bare number. The open journal's day is the
         page on screen. A blank square is left out altogether. -->
    <button
        class="cal-day"
        class:empty={day === null}
        class:today
        class:selected
        onclick={onPick}
        disabled={day === null}
        title={mark ? MARK_MEANINGS[mark] : undefined}
        aria-label={label}
        aria-current={selected ? 'page' : undefined}
        aria-hidden={day === null ? 'true' : undefined}
    >
        {@render face()}
    </button>
{:else}
    <span class="cal-day" class:today class:selected>{@render face()}</span>
{/if}

<style>
    /* The app's font rather than the browser's button font, as the sidebar's
       other buttons have it, so a day drawn as a picture is the same as one
       drawn as a button. */
    .cal-day {
        height: 30px;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        background: transparent;
        border: none;
        border-radius: var(--radius-md);
        transition: background 0.1s;
    }

    button.cal-day {
        cursor: pointer;
    }

    /* Under the number, where it reads as part of the day rather than a
       speck in its corner. The line controls are drawn with, which meets
       the 3:1 a mark needs on every scheme. */
    .journal-dot {
        position: absolute;
        bottom: 3px;
        left: 50%;
        width: 4px;
        height: 4px;
        margin-left: -2px;
        border-radius: 50%;
        background: var(--control-line);
        pointer-events: none;
    }

    .journal-dot.open-todos {
        background: var(--todo-open);
    }

    button.cal-day:hover:not(:disabled):not(.empty) {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .cal-day.today {
        background: var(--btn-primary-bg);
        color: var(--on-accent);
        font-weight: 600;
    }

    .cal-day.today .journal-dot {
        background: var(--on-accent);
    }

    button.cal-day.today:hover:not(:disabled) {
        background: var(--btn-primary-hover);
        color: var(--on-accent);
    }

    .cal-day.selected:not(.today) {
        box-shadow: inset 0 0 0 1.5px var(--accent-color);
        color: var(--text-primary);
    }

    .cal-day.today.selected {
        box-shadow:
            0 0 0 2px var(--bg-secondary),
            0 0 0 3.5px var(--accent-color);
    }

    .cal-day.empty {
        cursor: default;
    }

    .cal-day:disabled {
        cursor: default;
    }

    @media (pointer: coarse) {
        .cal-day {
            height: 36px;
            font-size: 14px;
        }
    }
</style>
