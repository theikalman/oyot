// Which days the journal calendar marks, and with what.
//
// Pure, and separate from the component, for the same reason the date
// arithmetic is: it is the part with a rule in it, and the component should
// only draw the answer. The journals are read through `journalEntries`, the
// list the Journals index is drawn from, so the calendar and the index cannot
// disagree about what a day holds.

import { journalEntries, type JournalEntry } from '$lib/journals/journalIndex';
import type { DocumentSummary } from '$lib/types';
import { MONTH_NAMES, weekdayName } from './calendar';

/**
 * What a day is marked with. A day with no mark has no journal, or one with
 * nothing written in it.
 *
 * - `entry`: something has been written on this day.
 * - `open-todos`: a task written on this day is still to do. It wins over
 *   `entry`, since it is the one that asks for the day to be opened again.
 */
export type DayMark = 'entry' | 'open-todos';

/**
 * What each mark says about its day, in a few words: the tooltip on a marked
 * day, and part of what a screen reader reads for it. The dot on its own
 * says it only in colour.
 */
export const MARK_MEANINGS: Record<DayMark, string> = {
    entry: 'Something written',
    'open-todos': 'A task still to do',
};

/**
 * A day of the calendar as a screen reader should read it: its date, whether
 * it is today, and what its dot means, as in "Thursday 10 September, today,
 * a task still to do". The number drawn on the day says none of that.
 */
export function dayLabel(date: Date, options: { mark?: DayMark; today?: boolean } = {}): string {
    const parts = [`${weekdayName(date)} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`];
    if (options.today) parts.push('today');
    if (options.mark) {
        const meaning = MARK_MEANINGS[options.mark];
        parts.push(meaning.charAt(0).toLowerCase() + meaning.slice(1));
    }
    return parts.join(', ');
}

function markFor(entry: JournalEntry): DayMark | null {
    // Asked first, and of the todos themselves rather than of `hasContent`:
    // the todo index would list the task either way, so the calendar should
    // not be the one place it goes unmentioned.
    if (entry.openTodoCount > 0) return 'open-todos';
    // Content rather than the row merely existing: an empty journal is a
    // day you have not written on.
    if (entry.hasContent) return 'entry';
    return null;
}

/**
 * The mark each day gets, keyed by the title of that day's journal.
 *
 * Worked out once for every journal, rather than by searching the list again
 * for each cell of the grid.
 */
export function dayMarks(documents: DocumentSummary[]): Map<string, DayMark> {
    const marks = new Map<string, DayMark>();
    for (const entry of journalEntries(documents)) {
        const mark = markFor(entry);
        // Never downgrade a day already found to have something open, should
        // a second journal ever turn up for it.
        if (mark && marks.get(entry.title) !== 'open-todos') marks.set(entry.title, mark);
    }
    return marks;
}
