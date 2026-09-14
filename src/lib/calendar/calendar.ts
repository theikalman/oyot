// The date arithmetic behind the journal calendar.
//
// Pure, and separate from the component, because it is the part with rules in
// it: which cells a month occupies, and how a date becomes the title of the
// journal for that day. A journal's id is derived from that title, so getting
// it wrong means two devices creating two entries for one day instead of
// converging on one.

/**
 * A journal's title for a given date: `YYYY-MM-DD`, in local time.
 *
 * Deliberately not `toISOString`, which converts to UTC first and so names
 * the wrong day for anyone east or west of it for part of every day.
 */
export function journalTitleFor(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** The title for `day` within the month `monthOf` falls in. */
export function journalTitleForDay(monthOf: Date, day: number): string {
    return journalTitleFor(new Date(monthOf.getFullYear(), monthOf.getMonth(), day));
}

/**
 * The cells of a month's grid: leading blanks for the days before the first,
 * then each day, then trailing blanks so the grid is whole weeks.
 */
export function monthGrid(monthOf: Date): Array<number | null> {
    const year = monthOf.getFullYear();
    const month = monthOf.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: Array<number | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
}

export const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

export const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function monthLabel(monthOf: Date): string {
    return `${MONTH_NAMES[monthOf.getMonth()]} ${monthOf.getFullYear()}`;
}

export function addMonths(monthOf: Date, delta: number): Date {
    return new Date(monthOf.getFullYear(), monthOf.getMonth() + delta, 1);
}

/** Whether `day` in the displayed month is the same date as `today`. */
export function isSameDay(monthOf: Date, day: number | null, today: Date): boolean {
    if (day === null) return false;
    return (
        day === today.getDate() &&
        monthOf.getMonth() === today.getMonth() &&
        monthOf.getFullYear() === today.getFullYear()
    );
}

/**
 * The day a journal's title names, or null if it does not name one.
 *
 * The inverse of `journalTitleFor`, and the only thing that can turn the
 * stored `YYYY-MM-DD` back into a date: a journal's day is in its title and
 * nowhere else.
 */
export function journalDateOf(title: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(title);
    if (!match) return null;

    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    // Round-tripped rather than range-checked: `new Date(2026, 1, 31)` is
    // happy to mean the 3rd of March, and reading that back as "31 Feb" would
    // name a day the title never did.
    return journalTitleFor(date) === title ? date : null;
}

/**
 * A journal's title as a person reads it: "Today", "Yesterday", or
 * "14 Sep 2026".
 *
 * A journal is named `YYYY-MM-DD`, which is the right thing to store (it
 * sorts, and it is what both devices derive the same id from) and the wrong
 * thing to put at the head of a list of someone's tasks.
 *
 * `today` is a parameter rather than `new Date()` read in here, so a caller
 * that is already tracking the date across midnight stays the one authority
 * on what day it is, and so this stays testable.
 *
 * A title that is not a date comes back untouched: the only thing that
 * guarantees a journal is named for a day is the code that creates it, and a
 * row that slipped through should still be readable.
 */
export function formatJournalTitle(title: string, today: Date): string {
    const date = journalDateOf(title);
    if (!date) return title;

    if (title === journalTitleFor(today)) return 'Today';
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (title === journalTitleFor(yesterday)) return 'Yesterday';

    return `${date.getDate()} ${MONTH_NAMES[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`;
}
