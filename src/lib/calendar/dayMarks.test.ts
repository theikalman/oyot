import { describe, it, expect } from 'vitest';
import { dayMarks } from './dayMarks';
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

describe('dayMarks', () => {
    it('marks a day that has something written on it', () => {
        const marks = dayMarks([doc('j1', '2026-09-14', 'journal')]);
        expect(marks.get('2026-09-14')).toBe('entry');
    });

    // Opening a day on the calendar makes its journal, so a row existing only
    // says the day was looked at.
    it('leaves a day whose journal has nothing in it unmarked', () => {
        const marks = dayMarks([doc('j1', '2026-09-14', 'journal', { has_content: false })]);
        expect(marks.has('2026-09-14')).toBe(false);
    });

    it('leaves a day with no journal unmarked', () => {
        const marks = dayMarks([doc('j1', '2026-09-14', 'journal')]);
        expect(marks.has('2026-09-13')).toBe(false);
    });

    // A note can be named anything, a date included, and it is still not
    // that day's journal.
    it('takes no mark from a note named like a date', () => {
        const marks = dayMarks([doc('n1', '2026-09-14', 'note')]);
        expect(marks.size).toBe(0);
    });

    // A journal's id is made from its day, so there should only ever be one.
    // Should two turn up, the one with something in it is the one to show.
    it('marks a day if any of its journals has something written on it', () => {
        const marks = dayMarks([
            doc('j1', '2026-09-14', 'journal'),
            doc('j2', '2026-09-14', 'journal', { has_content: false }),
        ]);
        expect(marks.get('2026-09-14')).toBe('entry');
    });
});
