<script lang="ts">
    import type { DayMark } from '$lib/calendar/dayMarks';

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
         * Opens the day. Left out, the day is only a picture of one, the way
         * the help page shows it, with nothing about it to press.
         */
        onPick?: () => void;
    }

    let { day, mark, today = false, selected = false, onPick }: Props = $props();
</script>

{#snippet face()}
    {#if mark}
        <span class="journal-dot" class:open-todos={mark === 'open-todos'}></span>
    {/if}
    {day ?? ''}
{/snippet}

{#if onPick}
    <button
        class="cal-day"
        class:empty={day === null}
        class:today
        class:selected
        onclick={onPick}
        disabled={day === null}
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
        aspect-ratio: 1;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
        font-size: 11px;
        color: var(--text-primary);
        background: transparent;
        border: none;
        border-radius: 4px;
        transition: background 0.1s;
    }

    button.cal-day {
        cursor: pointer;
    }

    /* The theme's secondary grey, which the sidebar's icons use too. A fixed
       #666 stayed the same in dark mode, where it was too dark to find:
       2.2:1 against today's cell, under the 3:1 a mark needs. */
    .journal-dot {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--text-secondary);
        pointer-events: none;
    }

    .journal-dot.open-todos {
        background: var(--todo-open);
    }

    button.cal-day:hover:not(:disabled):not(.empty) {
        background: var(--bg-hover);
    }

    .cal-day.today {
        background: var(--accent-bg);
        color: var(--accent-color);
        font-weight: 700;
    }

    .cal-day.selected:not(.today) {
        box-shadow: inset 0 0 0 1.5px var(--accent-color);
    }

    .cal-day.today.selected {
        box-shadow: inset 0 0 0 2px var(--accent-color);
    }

    .cal-day.empty {
        cursor: default;
    }

    .cal-day:disabled {
        cursor: default;
    }
</style>
