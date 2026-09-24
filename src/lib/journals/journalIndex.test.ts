import { describe, it, expect } from 'vitest';
import { groupByMonth, journalEntries } from './journalIndex';
import { tagsByDocument } from '$lib/tags/documentTags';
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

describe('journalEntries', () => {
    it('takes the journals and leaves the notes', () => {
        const entries = journalEntries([
            doc('j1', '2026-09-14', 'journal'),
            doc('n1', 'Groceries', 'note'),
        ]);

        expect(entries.map((e) => e.id)).toEqual(['j1']);
    });

    it('lists the newest day first', () => {
        const entries = journalEntries([
            doc('j1', '2026-08-31', 'journal'),
            doc('j2', '2026-09-14', 'journal'),
            doc('j3', '2026-09-02', 'journal'),
        ]);

        expect(entries.map((e) => e.title)).toEqual(['2026-09-14', '2026-09-02', '2026-08-31']);
    });

    // The index is a list of days, so a row with no day in its title has
    // nowhere to go. Only the code that creates journals names them, so this
    // is a bug elsewhere rather than something a user typed.
    it('leaves out a journal whose title is not a date', () => {
        const entries = journalEntries([
            doc('j1', 'Scratch', 'journal'),
            doc('j2', '2026-02-31', 'journal'),
            doc('j3', '2026-09-14', 'journal'),
        ]);

        expect(entries.map((e) => e.id)).toEqual(['j3']);
    });

    it('carries the day, the open todos and whether anything was written', () => {
        const [entry] = journalEntries([
            doc('j1', '2026-09-14', 'journal', {
                todo_count: 5,
                completed_todo_count: 2,
                has_content: false,
            }),
        ]);

        expect(entry.date.getFullYear()).toBe(2026);
        expect(entry.date.getMonth()).toBe(8);
        expect(entry.date.getDate()).toBe(14);
        expect(entry.todoCount).toBe(5);
        expect(entry.openTodoCount).toBe(3);
        expect(entry.hasContent).toBe(false);
    });

    // Counts arrive from two places that are updated separately, so a stale
    // pair can say more are done than exist. A negative badge is worse than a
    // zero one.
    it('never reports a negative number of open todos', () => {
        const [entry] = journalEntries([
            doc('j1', '2026-09-14', 'journal', { todo_count: 1, completed_todo_count: 3 }),
        ]);

        expect(entry.openTodoCount).toBe(0);
    });

    it('does not reorder the list it was given', () => {
        const documents = [doc('j1', '2026-08-31', 'journal'), doc('j2', '2026-09-14', 'journal')];
        journalEntries(documents);

        expect(documents.map((d) => d.id)).toEqual(['j1', 'j2']);
    });

    it('carries the tags the day is marked with', () => {
        const tags = tagsByDocument([
            { document_id: 'j1', name: 'gym' },
            { document_id: 'j1', name: 'work' },
            { document_id: 'j2', name: 'holiday' },
        ]);

        const entries = journalEntries(
            [doc('j1', '2026-09-14', 'journal'), doc('j3', '2026-09-13', 'journal')],
            tags,
        );

        expect(entries[0].tags).toEqual(['gym', 'work']);
        // A day carrying nothing gets an empty list, not the tags of a
        // document that is not on this page.
        expect(entries[1].tags).toEqual([]);
    });

    // The sidebar badge only counts the days, and asking SQL what is written
    // in them to do that would be a query for nothing.
    it('needs no tags to be handed over', () => {
        const [entry] = journalEntries([doc('j1', '2026-09-14', 'journal')]);
        expect(entry.tags).toEqual([]);
    });
});

describe('groupByMonth', () => {
    it('gathers the days of one month under one heading', () => {
        const months = groupByMonth(
            journalEntries([
                doc('j1', '2026-09-14', 'journal'),
                doc('j2', '2026-09-02', 'journal'),
                doc('j3', '2026-08-31', 'journal'),
            ]),
        );

        expect(months.map((m) => m.label)).toEqual(['September 2026', 'August 2026']);
        expect(months[0].entries.map((e) => e.title)).toEqual(['2026-09-14', '2026-09-02']);
        expect(months[1].entries.map((e) => e.title)).toEqual(['2026-08-31']);
    });

    it('tells one September from another', () => {
        const months = groupByMonth(
            journalEntries([
                doc('j1', '2026-09-01', 'journal'),
                doc('j2', '2025-09-01', 'journal'),
            ]),
        );

        expect(months.map((m) => m.key)).toEqual(['2026-09', '2025-09']);
    });

    // A run-based grouping would open a second September here. The page keys
    // its `{#each}` on the month, and two groups with one key is a render bug.
    it('gives a month one group however the days arrive', () => {
        const entries = journalEntries([
            doc('j1', '2026-09-14', 'journal'),
            doc('j2', '2026-08-31', 'journal'),
            doc('j3', '2026-09-02', 'journal'),
        ]);
        // Deliberately out of order, which `journalEntries` would never do.
        const months = groupByMonth([entries[2], entries[1], entries[0]]);

        expect(months.map((m) => m.key)).toEqual(['2026-08', '2026-09']);
        expect(months[1].entries.map((e) => e.title)).toEqual(['2026-09-02', '2026-09-14']);
    });

    it('is empty when there are no journals', () => {
        expect(groupByMonth(journalEntries([doc('n1', 'Groceries', 'note')]))).toEqual([]);
    });
});
