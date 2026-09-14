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
