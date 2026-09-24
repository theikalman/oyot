import { describe, it, expect } from 'vitest';
import { filterNotes, notesOf, noteStatus, pinnedNotes } from './noteIndex';
import type { DocumentSummary } from '$lib/types';

function doc(
    id: string,
    title: string,
    docType: string,
    extra: Partial<DocumentSummary> = {},
): DocumentSummary {
    return {
        id,
        doc_type: docType,
        title,
        todo_count: 0,
        completed_todo_count: 0,
        created_at: 0,
        updated_at: 0,
        has_content: true,
        pinned: false,
        ...extra,
    };
}

describe('notesOf', () => {
    it('takes the notes and leaves the journals', () => {
        const notes = notesOf([doc('j1', '2026-09-14', 'journal'), doc('n1', 'Groceries', 'note')]);

        expect(notes.map((n) => n.id)).toEqual(['n1']);
    });

    it('lists the newest note first', () => {
        const notes = notesOf([
            doc('n1', 'Oldest', 'note', { created_at: 10 }),
            doc('n2', 'Newest', 'note', { created_at: 30 }),
            doc('n3', 'Middle', 'note', { created_at: 20 }),
        ]);

        expect(notes.map((n) => n.title)).toEqual(['Newest', 'Middle', 'Oldest']);
    });

    // The store appends a note made during a session at the end, and the list
    // has to put it first all the same.
    it('orders by creation, not by where the store happens to hold a note', () => {
        const notes = notesOf([
            doc('n1', 'Loaded at startup', 'note', { created_at: 10 }),
            doc('n2', 'Made just now', 'note', { created_at: 20 }),
        ]);

        expect(notes[0].title).toBe('Made just now');
    });

    it('keeps two notes made in the same millisecond in one order', () => {
        const a = doc('a', 'A', 'note', { created_at: 10 });
        const b = doc('b', 'B', 'note', { created_at: 10 });

        expect(notesOf([b, a]).map((n) => n.id)).toEqual(['a', 'b']);
        expect(notesOf([a, b]).map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('leaves the list it was given as it was', () => {
        const documents = [
            doc('n1', 'Old', 'note', { created_at: 10 }),
            doc('n2', 'New', 'note', { created_at: 20 }),
        ];
        notesOf(documents);

        expect(documents.map((d) => d.id)).toEqual(['n1', 'n2']);
    });
});

describe('pinnedNotes', () => {
    it('keeps only the pinned notes, newest first', () => {
        const pinned = pinnedNotes([
            doc('n1', 'Pinned, old', 'note', { pinned: true, created_at: 10 }),
            doc('n2', 'Not pinned', 'note', { created_at: 20 }),
            doc('n3', 'Pinned, new', 'note', { pinned: true, created_at: 30 }),
        ]);

        expect(pinned.map((n) => n.title)).toEqual(['Pinned, new', 'Pinned, old']);
    });

    // Nothing offers a pin on a journal, and the section is for notes, so one
    // that arrived pinned from somewhere has no place in it.
    it('leaves out a pinned journal', () => {
        expect(pinnedNotes([doc('j1', '2026-09-14', 'journal', { pinned: true })])).toEqual([]);
    });
});

describe('filterNotes', () => {
    const notes = [doc('n1', 'Groceries', 'note'), doc('n2', 'House move', 'note')];

    it('matches part of a title, whatever its case', () => {
        expect(filterNotes(notes, 'GROC').map((n) => n.id)).toEqual(['n1']);
        expect(filterNotes(notes, 'se mo').map((n) => n.id)).toEqual(['n2']);
    });

    it('keeps every note for a blank filter', () => {
        expect(filterNotes(notes, '   ')).toEqual(notes);
    });

    it('finds nothing when nothing matches', () => {
        expect(filterNotes(notes, 'holiday')).toEqual([]);
    });
});

describe('noteStatus', () => {
    it('says when nothing has been written', () => {
        expect(noteStatus(doc('n1', 'Empty', 'note', { has_content: false }))).toBe(
            'Nothing written yet',
        );
    });

    it('counts the todos still open', () => {
        const one = doc('n1', 'One', 'note', { todo_count: 3, completed_todo_count: 2 });
        const two = doc('n2', 'Two', 'note', { todo_count: 3, completed_todo_count: 1 });

        expect(noteStatus(one)).toBe('1 open todo');
        expect(noteStatus(two)).toBe('2 open todos');
    });

    it('says when every todo is done', () => {
        const one = doc('n1', 'One', 'note', { todo_count: 1, completed_todo_count: 1 });
        const all = doc('n2', 'All', 'note', { todo_count: 4, completed_todo_count: 4 });

        expect(noteStatus(one)).toBe('1 todo, done');
        expect(noteStatus(all)).toBe('4 todos, all done');
    });

    it('says nothing about a note with writing and no todos', () => {
        expect(noteStatus(doc('n1', 'Prose', 'note'))).toBe('');
    });
});
