import { describe, it, expect } from 'vitest';
import { dayLabel, dayMarks, MARK_MEANINGS } from './dayMarks';
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

    it('marks a day with a task still to do', () => {
        const marks = dayMarks([
            doc('j1', '2026-09-14', 'journal', { todo_count: 3, completed_todo_count: 2 }),
        ]);
        expect(marks.get('2026-09-14')).toBe('open-todos');
    });

    it('marks a day whose tasks are all done as an ordinary entry', () => {
        const marks = dayMarks([
            doc('j1', '2026-09-14', 'journal', { todo_count: 3, completed_todo_count: 3 }),
        ]);
        expect(marks.get('2026-09-14')).toBe('entry');
    });

    // The counts come from two places updated separately, so a stale pair can
    // say more were done than exist. That is nothing left to do, not a task.
    it('takes more done than exist to mean nothing is left', () => {
        const marks = dayMarks([
            doc('j1', '2026-09-14', 'journal', { todo_count: 1, completed_todo_count: 3 }),
        ]);
        expect(marks.get('2026-09-14')).toBe('entry');
    });

    // The todo index lists the task whatever the content flag says, so the
    // calendar should not be the one place that hides it.
    it('marks a task still to do even if the day reads as empty', () => {
        const marks = dayMarks([
            doc('j1', '2026-09-14', 'journal', {
                todo_count: 1,
                completed_todo_count: 0,
                has_content: false,
            }),
        ]);
        expect(marks.get('2026-09-14')).toBe('open-todos');
    });

    it('takes no mark from a note named like a date with tasks in it', () => {
        const marks = dayMarks([
            doc('n1', '2026-09-14', 'note', { todo_count: 2, completed_todo_count: 0 }),
        ]);
        expect(marks.size).toBe(0);
    });

    it('lets a task still to do win whichever journal for the day comes first', () => {
        const open = doc('j1', '2026-09-14', 'journal', { todo_count: 1 });
        const done = doc('j2', '2026-09-14', 'journal');

        expect(dayMarks([open, done]).get('2026-09-14')).toBe('open-todos');
        expect(dayMarks([done, open]).get('2026-09-14')).toBe('open-todos');
    });
});

describe('dayLabel', () => {
    // 10 September 2026 is a Thursday.
    const day = new Date(2026, 8, 10);

    it('names the day by its date, not the bare number the calendar draws', () => {
        expect(dayLabel(day)).toBe('Thursday 10 September');
    });

    it('says when the day is today', () => {
        expect(dayLabel(day, { today: true })).toBe('Thursday 10 September, today');
    });

    it('says in words what the dot says in colour', () => {
        expect(dayLabel(day, { mark: 'entry' })).toBe('Thursday 10 September, something written');
        expect(dayLabel(day, { mark: 'open-todos', today: true })).toBe(
            'Thursday 10 September, today, a task still to do',
        );
    });
});

describe('MARK_MEANINGS', () => {
    // The hover text on a marked day, so it has to read as a label on its own.
    it('puts every mark in words, starting with a capital', () => {
        for (const meaning of Object.values(MARK_MEANINGS)) {
            expect(meaning).toMatch(/^[A-Z]/);
        }
        expect(Object.keys(MARK_MEANINGS).sort()).toEqual(['entry', 'open-todos']);
    });
});
