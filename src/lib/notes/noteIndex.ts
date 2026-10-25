// The shape of the notes index: every note, and the ones pinned to the
// sidebar.
//
// Pure, and separate from the pages, for the reason the journal index is: the
// order and the filter are rules, and a page is only markup over them. The
// sidebar and the Notes page take their order from here, so a note sits in the
// same place relative to the others in both.

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

/** The notes pinned to the sidebar, in the order every note is listed in. */
export function pinnedNotes(documents: DocumentSummary[]): DocumentSummary[] {
    return notesOf(documents).filter((doc) => doc.pinned);
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

/** The orders a phone's note list can be in. */
export type NoteOrder = 'edited' | 'created';

/** These notes, most recently edited first, or newest first as notesOf has them. */
export function sortNotes(notes: DocumentSummary[], order: NoteOrder): DocumentSummary[] {
    if (order === 'created') return notes;
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
