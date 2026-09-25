<script lang="ts">
    import type { DayMark } from '$lib/calendar/dayMarks';
    import CalendarDay from '$lib/components/CalendarDay.svelte';

    // What each look a calendar day can have means, each drawn by the
    // calendar's own day so the key cannot disagree with the calendar.
    // The rule deciding which dot a day gets is in $lib/calendar/dayMarks.
    interface Sample {
        day: number;
        mark?: DayMark;
        today?: boolean;
        selected?: boolean;
        name: string;
        meaning: string;
    }

    const SAMPLES: Sample[] = [
        { day: 4, mark: 'entry', name: 'Grey dot', meaning: 'You wrote something on this day.' },
        {
            day: 9,
            mark: 'open-todos',
            name: 'Orange dot',
            meaning:
                'A task on this day is still to do, even an empty one. The dot turns grey once every task on the day is ticked off.',
        },
        { day: 16, name: 'No dot', meaning: 'Nothing is written on this day yet.' },
        { day: 25, today: true, name: 'Blue background', meaning: 'Today.' },
        {
            day: 12,
            selected: true,
            name: 'Blue outline',
            meaning: 'The day whose journal is open.',
        },
        {
            day: 25,
            today: true,
            selected: true,
            name: 'Both',
            meaning: "Today, with today's journal open, which is how Oyot starts.",
        },
    ];
</script>

<ul class="legend">
    {#each SAMPLES as sample (sample.name)}
        <li class="item">
            <!-- A picture of the day, which the words beside it describe. -->
            <span class="sample" aria-hidden="true">
                <CalendarDay
                    day={sample.day}
                    mark={sample.mark}
                    today={sample.today}
                    selected={sample.selected}
                />
            </span>
            <span class="text">
                <strong class="name">{sample.name}</strong>
                <span class="meaning">{sample.meaning}</span>
            </span>
        </li>
    {/each}
</ul>

<style>
    /* Framed and filled like the calendar, so the days sit on what they sit
       on in the sidebar. */
    .legend {
        margin: 0;
        padding: 4px 12px;
        list-style: none;
        border: 1px solid var(--border-light);
        border-radius: 8px;
        background: var(--bg-primary);
    }

    .item {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        padding: 8px 0;
    }

    .item + .item {
        border-top: 1px solid var(--border-color);
    }

    /* The width of a day in the sidebar, so the dot is the size it is
       there. */
    .sample {
        flex-shrink: 0;
        width: 28px;
    }

    .text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-top: 4px;
        min-width: 0;
    }

    .name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .meaning {
        font-size: 14px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
</style>
