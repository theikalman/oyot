import { addDays, journalTitleFor, weekdayName, WEEKDAY_NAMES } from '$lib/calendar/calendar';
import type { JournalEntry } from './journalIndex';

// What the Journals page draws in each of its views: the list (with runs of
// empty days folded into one line), a month, and the whole year, plus the
// year strip above the list. Worked out here, apart from the page, so it can
// be tested.

/** The three ways the Journals page shows the days, closest first. */
export const JOURNAL_VIEWS = ['list', 'month', 'year'] as const;
export type JournalView = (typeof JOURNAL_VIEWS)[number];

/**
 * The view one step further out (`-1`, a pinch in or Ctrl and scroll down) or
 * further in (`+1`), or the same view at either end.
 */
export function zoomView(view: JournalView, outward: boolean): JournalView {
    const i = JOURNAL_VIEWS.indexOf(view) + (outward ? 1 : -1);
    return JOURNAL_VIEWS[Math.min(Math.max(i, 0), JOURNAL_VIEWS.length - 1)];
}

/** What a day holds, which is what its mark on a calendar says. */
export type DayState = 'none' | 'written' | 'open' | 'empty';

export function dayState(entry: JournalEntry | undefined): DayState {
    if (!entry) return 'none';
    if (entry.openTodoCount > 0) return 'open';
    return entry.hasContent ? 'written' : 'empty';
}

/** A row of the list: a day, or a run of days with nothing written. */
export type ListRow =
    | { kind: 'day'; entry: JournalEntry }
    | { kind: 'gap'; key: string; label: string; count: number };

/**
 * A month's entries as list rows, with each run of entries that have nothing
 * written folded into one line, "Wednesday 14 to Thursday 15", so a month of
 * browsing the calendar does not bury the days that were written in. The
 * entries arrive newest first, and a run is read oldest to newest.
 */
export function listRows(entries: JournalEntry[]): ListRow[] {
    const rows: ListRow[] = [];
    let run: JournalEntry[] = [];

    const flush = () => {
        if (run.length === 0) return;
        const newest = run[0];
        const oldest = run[run.length - 1];
        const name = (e: JournalEntry) => `${weekdayName(e.date)} ${e.date.getDate()}`;
        rows.push({
            kind: 'gap',
            key: `gap-${oldest.title}`,
            label: run.length === 1 ? name(newest) : `${name(oldest)} to ${name(newest)}`,
            count: run.length,
        });
        run = [];
    };

    for (const entry of entries) {
        if (!entry.hasContent && entry.openTodoCount === 0) {
            run.push(entry);
            continue;
        }
        flush();
        rows.push({ kind: 'day', entry });
    }
    flush();
    return rows;
}

/** A day's todos, said short: "1 open", "3 done", or nothing. */
export function shortStatus(entry: JournalEntry): { text: string; tone: 'todo' | 'ok' } | null {
    if (entry.openTodoCount > 0) return { text: `${entry.openTodoCount} open`, tone: 'todo' };
    if (entry.todoCount > 0) return { text: `${entry.todoCount} done`, tone: 'ok' };
    return null;
}

/** One square of a month or of the year strip. */
export interface DayCell {
    /** `YYYY-MM-DD`, or null for a blank square outside the month or year. */
    title: string | null;
    day: number;
    state: DayState;
    today: boolean;
    future: boolean;
}

function cellFor(date: Date, byTitle: Map<string, JournalEntry>, today: Date): DayCell {
    const title = journalTitleFor(date);
    const todayTitle = journalTitleFor(today);
    return {
        title,
        day: date.getDate(),
        state: dayState(byTitle.get(title)),
        today: title === todayTitle,
        future: title > todayTitle,
    };
}

/** A month as calendar squares, blanks before the 1st so it starts on Sunday. */
export function monthCells(
    year: number,
    month: number,
    entries: JournalEntry[],
    today: Date,
): DayCell[] {
    const byTitle = new Map(entries.map((e) => [e.title, e]));
    const first = new Date(year, month, 1);
    const length = new Date(year, month + 1, 0).getDate();
    const cells: DayCell[] = [];
    for (let i = 0; i < first.getDay(); i++) {
        cells.push({ title: null, day: 0, state: 'none', today: false, future: false });
    }
    for (let d = 1; d <= length; d++) cells.push(cellFor(new Date(year, month, d), byTitle, today));
    return cells;
}

/**
 * The year strip: a column per week from the Sunday on or before the 1st of
 * January, seven days down each, with blanks outside the year, and where
 * each month's label goes.
 */
export function yearStrip(
    year: number,
    entries: JournalEntry[],
    today: Date,
): { weeks: DayCell[][]; months: { label: string; week: number }[] } {
    const byTitle = new Map(entries.map((e) => [e.title, e]));
    const jan1 = new Date(year, 0, 1);
    const start = addDays(jan1, -jan1.getDay());
    const weeks: DayCell[][] = [];
    const months: { label: string; week: number }[] = [];
    for (let w = 0; w < 54; w++) {
        const week: DayCell[] = [];
        for (let d = 0; d < 7; d++) {
            const date = addDays(start, w * 7 + d);
            if (date.getFullYear() !== year) {
                week.push({ title: null, day: 0, state: 'none', today: false, future: false });
                continue;
            }
            if (date.getDate() === 1) {
                months.push({
                    label: date.toLocaleDateString(undefined, { month: 'short' }),
                    week: w,
                });
            }
            week.push(cellFor(date, byTitle, today));
        }
        if (week.every((c) => c.title === null) && w > 0) break;
        weeks.push(week);
    }
    return { weeks, months };
}

/** The short day names for a calendar's header row, Sunday first. */
export const SHORT_DAYS = WEEKDAY_NAMES.map((name) => name.slice(0, 2));
