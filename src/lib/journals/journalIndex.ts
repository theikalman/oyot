// The shape of the journal index: every journal the user has, newest first,
// gathered under the month it belongs to.
//
// Pure, and separate from the page, because it is the part with rules in it:
// which journals can be placed on a calendar at all, and what order days and
// months are read in. The page is then only markup over the result.

import { journalDateOf, monthLabel } from '$lib/calendar/calendar';
import type { DocumentSummary } from '$lib/types';

/** One journal, as the index lists it. */
export interface JournalEntry {
    id: string;
    /** The stored title, `YYYY-MM-DD`. This is what the calendar matches on. */
    title: string;
    /** The day that title names. */
    date: Date;
    todoCount: number;
    openTodoCount: number;
    /** Whether anything has been written on this day. */
    hasContent: boolean;
}

/** One month's journals, under the heading they are shown beneath. */
export interface JournalMonth {
    /** `YYYY-MM`: the key the group is identified by, and its sort order. */
    key: string;
    /** The heading, e.g. "September 2026". */
    label: string;
    entries: JournalEntry[];
}

/**
 * Every journal among these documents, newest day first.
 *
 * A journal whose title is not a date is left out rather than listed under a
 * heading invented for it: this page is an index of days, and a row it cannot
 * place on a calendar is not one. Only the code that creates journals names
 * them, so such a row is a bug elsewhere, not something a user made.
 */
export function journalEntries(documents: DocumentSummary[]): JournalEntry[] {
    const entries: JournalEntry[] = [];

    for (const doc of documents) {
        if (doc.doc_type !== 'journal') continue;
        const date = journalDateOf(doc.title);
        if (!date) continue;

        entries.push({
            id: doc.id,
            title: doc.title,
            date,
            todoCount: doc.todo_count,
            openTodoCount: Math.max(doc.todo_count - doc.completed_todo_count, 0),
            hasContent: doc.has_content,
        });
    }

    // Newest first, which is the order a journal is looked for in: the day you
    // want is nearly always a recent one.
    return entries.sort((a, b) => b.title.localeCompare(a.title));
}

/**
 * Gather entries under their month, in the order they arrive in.
 *
 * The days are not reordered. The caller has already put them in the order it
 * wants them read, and the months follow from that, so sorting again here
 * would be a second opinion about the same thing. Keyed by month rather than
 * cut at each change of one, so a caller that hands over an unsorted list gets
 * one group per month instead of the same month twice.
 */
export function groupByMonth(entries: JournalEntry[]): JournalMonth[] {
    const months = new Map<string, JournalMonth>();

    for (const entry of entries) {
        const key = entry.title.slice(0, 7);
        let month = months.get(key);
        if (!month) {
            month = { key, label: monthLabel(entry.date), entries: [] };
            months.set(key, month);
        }
        month.entries.push(entry);
    }

    return [...months.values()];
}
