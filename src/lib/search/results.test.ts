import { describe, it, expect } from 'vitest';
import { groupTodos, type TodoHit } from '$lib/todos/grouping';
import { searchTerms } from '$lib/todos/todoSearch';
import type { MarkedSegment } from '$lib/todos/todoText';
import type { DocumentSummary } from '$lib/types';
import {
    documentResults,
    taggedResults,
    tagTerms,
    todoResults,
    type SearchHit,
    type TaggedResult,
} from './results';
import { MATCH_END, MATCH_START } from './snippet';

const mark = (s: string) => `${MATCH_START}${s}${MATCH_END}`;

/** A row's text as it reads, with what matched in [brackets]. */
function read(runs: { text: string; match: boolean }[]): string {
    return runs.map((run) => (run.match ? `[${run.text}]` : run.text)).join('');
}

describe('documentResults', () => {
    const hit = (over: Partial<SearchHit>): SearchHit => ({
        id: 'n1',
        doc_type: 'note',
        title: 'Quarterly review',
        marked_title: 'Quarterly review',
        snippet: '',
        ...over,
    });

    it('keeps the order the index ranked the hits in', () => {
        const results = documentResults([hit({ id: 'b' }), hit({ id: 'a' })]);
        expect(results.map((r) => r.key)).toEqual(['b', 'a']);
        expect(results.map((r) => r.docId)).toEqual(['b', 'a']);
    });

    it('marks what matched in the title and in the text', () => {
        const [result] = documentResults([
            hit({
                marked_title: `${mark('Quarterly')} review`,
                snippet: `the ${mark('quarterly')} numbers`,
            }),
        ]);
        expect(read(result.titleParts)).toBe('[Quarterly] review');
        expect(read(result.snippet)).toBe('the [quarterly] numbers');
    });

    it('shows the title as it is when nothing in it matched', () => {
        const [result] = documentResults([hit({ snippet: `a ${mark('budget')}` })]);
        expect(read(result.titleParts)).toBe('Quarterly review');
    });

    // A hit from a build that does not mark titles has none to show.
    it('falls back to the title when there is no marked one', () => {
        const [result] = documentResults([hit({ marked_title: '' })]);
        expect(read(result.titleParts)).toBe('Quarterly review');
    });

    it('carries what kind of document it is, and its stored title', () => {
        const [result] = documentResults([
            hit({ id: 'j1', doc_type: 'journal', title: '2026-09-30', marked_title: '2026-09-30' }),
        ]);
        expect(result).toMatchObject({
            kind: 'document',
            docType: 'journal',
            title: '2026-09-30',
        });
    });
});

describe('todoResults', () => {
    function todo(docId: string, docType: string, ordinal: number, text: string, checked = false) {
        const row: TodoHit = {
            document_id: docId,
            document_title: docId === 'j1' ? '2026-09-30' : docId.toUpperCase(),
            doc_type: docType,
            ordinal,
            text,
            checked,
            depth: 0,
        };
        return row;
    }

    const sections = groupTodos(
        [
            todo('j1', 'journal', 0, 'call the bank'),
            todo('j1', 'journal', 1, 'buy #milk', true),
            todo('n1', 'note', 0, 'fix the roof'),
            todo('n2', 'note', 0, 'milk the cows'),
            todo('n2', 'note', 1, 'feed the hens'),
        ],
        new Map([['j1', ['milk']]]),
    );

    const readTodo = (segments: MarkedSegment[]) =>
        segments.map((s) => (s.kind === 'tag' ? `<${read(s.runs)}>` : read(s.runs))).join('');

    it('finds nothing before anything is typed', () => {
        expect(todoResults(sections, [])).toEqual([]);
    });

    it('lists the todos with every word, journals first, finished ones too', () => {
        const results = todoResults(sections, searchTerms('milk'));
        expect(results.map((r) => [r.docId, r.ordinal, r.checked])).toEqual([
            ['j1', 1, true],
            ['n2', 0, false],
        ]);
    });

    it('says which document each todo is in, and how to open it', () => {
        const [result] = todoResults(sections, searchTerms('bank'));
        expect(result).toMatchObject({
            kind: 'todo',
            key: 'j1/0',
            docId: 'j1',
            docType: 'journal',
            title: '2026-09-30',
            ordinal: 0,
        });
    });

    it("draws the document's tags as chips, and marks what matched", () => {
        const results = todoResults(sections, searchTerms('mil'));
        expect(results.map((r) => readTodo(r.text))).toEqual(['buy <#[mil]k>', '[mil]k the cows']);
    });

    it('gives each todo its own key', () => {
        const keys = todoResults(sections, searchTerms('the')).map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual(['j1/0', 'n1/0', 'n2/0', 'n2/1']);
    });
});

describe('tagTerms', () => {
    it('takes the words a tag would be spelled with, hash or not', () => {
        expect(tagTerms('#Work urgent')).toEqual(['work', 'urgent']);
    });

    it('looks for a word once, with its hash or without', () => {
        expect(tagTerms('#work work')).toEqual(['work']);
    });

    it('has nothing to look for in a hash alone', () => {
        expect(tagTerms('#')).toEqual([]);
        expect(tagTerms(' ## ')).toEqual([]);
    });

    it('folds accents as a tag search does', () => {
        expect(tagTerms('#Café')).toEqual(['cafe']);
    });
});

describe('taggedResults', () => {
    function doc(id: string, docType: string, title: string, updatedAt = 1): DocumentSummary {
        return {
            id,
            doc_type: docType,
            title,
            todo_count: 0,
            completed_todo_count: 0,
            created_at: 1,
            updated_at: updatedAt,
            has_content: true,
            pinned: false,
        };
    }

    const documents = [
        doc('n-old', 'note', 'Old plans', 10),
        doc('j-sep', 'journal', '2026-09-01'),
        doc('n-new', 'note', 'Reading list', 20),
        doc('j-oct', 'journal', '2026-10-01'),
        doc('n-bare', 'note', 'No tags at all', 30),
    ];
    const tags = new Map([
        ['n-old', ['homework', 'school']],
        ['j-sep', ['work']],
        ['n-new', ['books', 'work']],
        ['j-oct', ['urgent', 'work']],
    ]);

    const chips = (result: TaggedResult) => result.tags.map((t) => read(t.runs));
    const search = (query: string) => taggedResults(documents, tags, tagTerms(query));

    it('finds nothing before anything is typed', () => {
        expect(taggedResults(documents, tags, [])).toEqual([]);
    });

    it("lists what is tagged as a tag's page does: journals newest first, then notes", () => {
        expect(search('work').map((r) => r.docId)).toEqual(['j-oct', 'j-sep', 'n-new', 'n-old']);
    });

    it('finds a tag by part of its name, and shows only the tags that matched', () => {
        const [, , , homework] = search('work');
        expect(chips(homework)).toEqual(['#home[work]']);
    });

    it('takes a word typed with its hash as the same word', () => {
        expect(search('#work').map((r) => r.docId)).toEqual(search('work').map((r) => r.docId));
    });

    it('needs every word in one tag or another, not all in the same one', () => {
        const results = search('work urgent');
        expect(results.map((r) => r.docId)).toEqual(['j-oct']);
        expect(chips(results[0])).toEqual(['#[urgent]', '#[work]']);
    });

    it('leaves out what carries no tag, or none that matches', () => {
        expect(search('books').map((r) => r.docId)).toEqual(['n-new']);
        expect(search('tags')).toEqual([]);
    });

    it('carries what a row needs to open its document', () => {
        const [result] = search('books');
        expect(result).toMatchObject({
            kind: 'tagged',
            key: 'n-new',
            docId: 'n-new',
            docType: 'note',
            title: 'Reading list',
        });
    });

    // The tags come from SQL and the documents from the store, which can be
    // a moment apart when a peer's document arrives.
    it('lists only documents it has a title for', () => {
        const withStranger = new Map([...tags, ['unknown', ['work']]]);
        const ids = taggedResults(documents, withStranger, tagTerms('work')).map((r) => r.docId);
        expect(ids).not.toContain('unknown');
    });

    it('does not reorder the documents it was given', () => {
        const before = documents.map((d) => d.id);
        search('work');
        expect(documents.map((d) => d.id)).toEqual(before);
    });
});
