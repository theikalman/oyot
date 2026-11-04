// The shape of the notes index: every note, and the ones pinned to the
// sidebar.
//
// Pure, and separate from the pages, for the reason the journal index is: the
// order and the filter are rules, and a page is only markup over them. The
// sidebar and the Notes page take their order from here.

import { comparePinned } from '$lib/notes/pinOrder';
import { NO_TAGS, tagsOf, type TagsByDocument } from '$lib/tags/documentTags';
import { normalizeTagName } from '$lib/tiptap/tags';
import type { DocumentSummary } from '$lib/types';

/**
 * Every note among these documents, newest first.
 *
 * Journals are left out: a journal is reached by its day, through the calendar
 * and the journal index, and a note is everything else.
 *
 * Newest first is the order the sidebar has always listed notes in, so notes
 * stay where the user is used to finding them. Sorted here rather than trusted
 * to arrive in order, because the store appends a note made during a session
 * at the end, where it would sit until the next launch. The id breaks a tie,
 * so two notes made in the same millisecond do not swap places between renders.
 */
export function notesOf(documents: DocumentSummary[]): DocumentSummary[] {
    return documents
        .filter((doc) => doc.doc_type === 'note')
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
}

/**
 * The notes pinned to the sidebar, in the order the user put them (ADR 0039).
 * Those never placed by hand come first, newest first, as every note is listed.
 */
export function pinnedNotes(documents: DocumentSummary[]): DocumentSummary[] {
    return notesOf(documents)
        .filter((doc) => doc.pinned)
        .sort(comparePinned);
}

/**
 * The notes `query` finds: its text is in the title, or in one of the note's
 * tags, ignoring case either way. A blank query keeps them all.
 *
 * Starting with `#` asks about tags alone, the way a chip is spelled, so
 * `#home` finds the notes tagged home and not one titled "Homework". A `#` on
 * its own keeps every note with a tag at all, which is where typing one
 * begins.
 */
export function filterNotes(
    notes: DocumentSummary[],
    query: string,
    tags: TagsByDocument = NO_TAGS,
): DocumentSummary[] {
    const text = query.trim();
    if (!text) return notes;

    // Spelled the way a stored tag is, so the comparison is like for like.
    const tagNeedle = normalizeTagName(text);
    const hasTag = (doc: DocumentSummary) =>
        tagsOf(tags, doc.id).some((tag) => tag.includes(tagNeedle));
    if (text.startsWith('#')) return notes.filter(hasTag);

    const titleNeedle = text.toLocaleLowerCase();
    return notes.filter(
        (doc) => doc.title.toLocaleLowerCase().includes(titleNeedle) || hasTag(doc),
    );
}

/**
 * What a row says about a note, spelled out the way the journal index spells
 * out a day: a bare number leaves the reader to work out what is being counted.
 */
export function noteStatus(note: DocumentSummary): string {
    if (!note.has_content) return 'Nothing written yet';
    const open = Math.max(note.todo_count - note.completed_todo_count, 0);
    if (open > 0) return open === 1 ? '1 open todo' : `${open} open todos`;
    if (note.todo_count > 0) {
        return note.todo_count === 1 ? '1 todo, done' : `${note.todo_count} todos, all done`;
    }
    return '';
}

/** The orders the Notes page can list notes in, as it offers them. */
export const NOTE_ORDERS = ['name', 'created', 'edited'] as const;

export type NoteOrder = (typeof NOTE_ORDERS)[number];

/** How the Notes page lists notes until the user picks something else. */
export const DEFAULT_NOTE_ORDER: NoteOrder = 'name';

export const NOTE_ORDER_LABELS: Record<NoteOrder, string> = {
    name: 'Name',
    created: 'Date created',
    edited: 'Last edited',
};

/** The order a stored value names, or the default when it names none this build knows. */
export function parseNoteOrder(value: unknown): NoteOrder {
    return NOTE_ORDERS.find((order) => order === value) ?? DEFAULT_NOTE_ORDER;
}

/** The order after this one, for a control that steps through them. */
export function nextNoteOrder(order: NoteOrder): NoteOrder {
    return NOTE_ORDERS[(NOTE_ORDERS.indexOf(order) + 1) % NOTE_ORDERS.length];
}

// The way a person reads a list of names rather than the way a computer does:
// "apple" sits by "Apple", not after "Zebra", and "Week 2" comes before
// "Week 10".
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * These notes by name from A to Z, most recently edited first, or newest first
 * as notesOf has them. The id breaks a tie, as it does there, so two notes with
 * the same title do not swap places between renders.
 */
export function sortNotes(notes: DocumentSummary[], order: NoteOrder): DocumentSummary[] {
    if (order === 'created') return notes;
    if (order === 'name') {
        return [...notes].sort(
            (a, b) => byName.compare(a.title, b.title) || a.id.localeCompare(b.id),
        );
    }
    return [...notes].sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
}

const SHORT_MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];

/**
 * When a note was last edited, the way a row on a phone says it: "Today",
 * "Yesterday", "3 days ago" within the week, then "Oct 11", with the year
 * once it is another year's.
 */
export function editedLabel(ms: number, now: Date): string {
    const day = new Date(ms);
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(day)) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    const label = `${SHORT_MONTHS[day.getMonth()]} ${day.getDate()}`;
    return day.getFullYear() === now.getFullYear() ? label : `${label}, ${day.getFullYear()}`;
}

/** How many todos in a note are still open. */
export function openTodos(note: DocumentSummary): number {
    return Math.max(note.todo_count - note.completed_todo_count, 0);
}
