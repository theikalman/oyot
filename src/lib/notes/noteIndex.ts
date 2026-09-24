// The shape of the notes index: every note, and the ones pinned to the
// sidebar.
//
// Pure, and separate from the pages, for the reason the journal index is: the
// order and the filter are rules, and a page is only markup over them. The
// sidebar and the Notes page take their order from here, so a note sits in the
// same place relative to the others in both.

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

/** The notes whose title holds `query`, ignoring case. A blank query keeps them all. */
export function filterNotes(notes: DocumentSummary[], query: string): DocumentSummary[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return notes;
    return notes.filter((doc) => doc.title.toLocaleLowerCase().includes(needle));
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
