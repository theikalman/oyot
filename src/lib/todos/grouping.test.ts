import { describe, it, expect } from 'vitest';
import { groupTodos, countOpen, countAll, type TodoHit } from './grouping';

function hit(
    docId: string,
    title: string,
    docType: string,
    ordinal: number,
    text: string,
    checked = false,
): TodoHit {
    return {
        document_id: docId,
        document_title: title,
        doc_type: docType,
        ordinal,
        text,
        checked,
        depth: 0,
    };
}

describe('groupTodos', () => {
    it('puts journals and notes in their own sections', () => {
        const sections = groupTodos([
            hit('j1', '2026-09-14', 'journal', 0, 'call the bank'),
            hit('n1', 'Groceries', 'note', 0, 'buy milk'),
        ]);

        expect(sections.journals.map((g) => g.title)).toEqual(['2026-09-14']);
        expect(sections.notes.map((g) => g.title)).toEqual(['Groceries']);
    });

    it('gathers one document into one group, in row order', () => {
        const sections = groupTodos([
            hit('n1', 'Groceries', 'note', 0, 'milk'),
            hit('n1', 'Groceries', 'note', 1, 'eggs'),
            hit('n1', 'Groceries', 'note', 2, 'bread'),
        ]);

        expect(sections.notes).toHaveLength(1);
        expect(sections.notes[0].todos.map((t) => t.text)).toEqual(['milk', 'eggs', 'bread']);
    });

    // The query's order is the only order. Re-sorting here would have to pick
    // one key for two kinds of document that want different ones.
    it('keeps the order the rows arrived in', () => {
        const sections = groupTodos([
            hit('j2', '2026-09-14', 'journal', 0, 'today'),
            hit('j1', '2026-09-01', 'journal', 0, 'earlier'),
            hit('n2', 'Fresh', 'note', 0, 'recent'),
            hit('n1', 'Stale', 'note', 0, 'old'),
        ]);

        expect(sections.journals.map((g) => g.title)).toEqual(['2026-09-14', '2026-09-01']);
        expect(sections.notes.map((g) => g.title)).toEqual(['Fresh', 'Stale']);
    });

    // Two notes sharing a heading are still two notes, and clicking an item
    // has to open the one it came from.
    it('keeps two documents with the same title apart', () => {
        const sections = groupTodos([
            hit('n1', 'Notes', 'note', 0, 'first'),
            hit('n2', 'Notes', 'note', 0, 'second'),
        ]);

        expect(sections.notes.map((g) => g.docId)).toEqual(['n1', 'n2']);
    });

    it('has nothing to show for no rows', () => {
        expect(groupTodos([])).toEqual({ journals: [], notes: [] });
    });

    // A group's tags are what its rows draw as chips, so they have to be
    // that document's and nobody else's.
    it("carries each document's own tags", () => {
        const sections = groupTodos(
            [
                hit('j1', '2026-09-14', 'journal', 0, 'call mum #urgent'),
                hit('n1', 'Groceries', 'note', 0, 'buy milk'),
                hit('n2', 'House', 'note', 0, 'fix the #roof'),
            ],
            new Map([
                ['j1', ['urgent']],
                ['n2', ['home', 'roof']],
            ]),
        );

        expect(sections.journals[0].tags).toEqual(['urgent']);
        expect(sections.notes.map((g) => g.tags)).toEqual([[], ['home', 'roof']]);
    });
});

describe('counting', () => {
    const sections = groupTodos([
        hit('j1', '2026-09-14', 'journal', 0, 'done', true),
        hit('j1', '2026-09-14', 'journal', 1, 'open'),
        hit('n1', 'Groceries', 'note', 0, 'milk'),
    ]);

    it('counts what is left across both sections', () => {
        expect(countOpen(sections)).toBe(2);
    });

    it('counts everything across both sections', () => {
        expect(countAll(sections)).toBe(3);
    });
});
