// Which days the journal calendar marks, and with what.
//
// Pure, and separate from the component, for the same reason the date
// arithmetic is: it is the part with a rule in it, and the component should
// only draw the answer. The journals are read through `journalEntries`, the
// list the Journals index is drawn from, so the calendar and the index cannot
// disagree about what a day holds.

import { journalEntries } from '$lib/journals/journalIndex';
import type { DocumentSummary } from '$lib/types';

/**
 * What a day is marked with. A day with no mark has no journal, or one with
 * nothing written in it.
 *
 * - `entry`: something has been written on this day.
 */
export type DayMark = 'entry';

/**
 * The mark each day gets, keyed by the title of that day's journal.
 *
 * Worked out once for every journal, rather than by searching the list again
 * for each cell of the grid.
 */
export function dayMarks(documents: DocumentSummary[]): Map<string, DayMark> {
    const marks = new Map<string, DayMark>();
    for (const entry of journalEntries(documents)) {
        // Content rather than the row merely existing: an empty journal is a
        // day you have not written on.
        if (entry.hasContent) marks.set(entry.title, 'entry');
    }
    return marks;
}
