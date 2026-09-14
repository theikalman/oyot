import { describe, it, expect } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { extractDocumentIndex } from './documentIndex';

// A minimal schema with the node types the extractor cares about, so these
// tests do not need a live Tiptap editor.
const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*' },
        text: { group: 'inline' },
        documentLink: {
            group: 'inline',
            inline: true,
            atom: true,
            attrs: { targetId: { default: null }, title: { default: null } },
        },
        taskList: { group: 'block', content: 'taskItem+' },
        taskItem: { content: 'paragraph block*', attrs: { checked: { default: false } } },
        image: {
            group: 'block',
            atom: true,
            attrs: { src: { default: null }, alt: { default: null } },
        },
    },
});

const t = (s: string) => schema.text(s);
const para = (...content: PMNode[]) => schema.nodes.paragraph.create(null, content);
const doc = (...content: PMNode[]) => schema.nodes.doc.create(null, content);
const link = (targetId: string, title: string) =>
    schema.nodes.documentLink.create({ targetId, title });
const task = (checked: boolean, text: string, ...nested: PMNode[]) =>
    schema.nodes.taskItem.create({ checked }, [text ? para(t(text)) : para(), ...nested]);
const taskList = (...items: PMNode[]) => schema.nodes.taskList.create(null, items);

describe('extractDocumentIndex', () => {
    it('collects the plain text', () => {
        const d = doc(para(t('first line')), para(t('second line')));
        expect(extractDocumentIndex(d).text).toBe('first line second line');
    });

    // Joining without a separator would glue 'line' to 'second' and make both
    // unmatchable in the search index.
    it('keeps a separator between blocks', () => {
        const d = doc(para(t('alpha')), para(t('beta')));
        expect(extractDocumentIndex(d).text).toBe('alpha beta');
    });

    it('normalises runs of whitespace', () => {
        const d = doc(para(t('  spaced    out  ')));
        expect(extractDocumentIndex(d).text).toBe('spaced out');
    });

    it('collects link targets and deduplicates them', () => {
        const d = doc(
            para(t('see '), link('doc-1', 'One'), t(' and '), link('doc-2', 'Two')),
            para(link('doc-1', 'One again')),
        );
        const index = extractDocumentIndex(d);
        expect(index.linkTargets.sort()).toEqual(['doc-1', 'doc-2']);
    });

    // The link's title is how the user refers to the other document from here,
    // so it should be findable.
    it('indexes a link title as text', () => {
        const d = doc(para(t('about '), link('doc-1', 'Quarterly Review')));
        expect(extractDocumentIndex(d).text).toContain('Quarterly Review');
    });

    it('counts todos and completions', () => {
        const d = doc(taskList(task(false, 'one'), task(true, 'two'), task(true, 'three')));
        const index = extractDocumentIndex(d);
        expect(index.todoCount).toBe(3);
        expect(index.completedTodoCount).toBe(2);
    });

    it('records every todo in document order', () => {
        const d = doc(
            para(t('intro')),
            taskList(task(false, 'buy milk'), task(true, 'call the bank')),
            para(t('between')),
            taskList(task(false, 'book the flight')),
        );
        expect(extractDocumentIndex(d).todos).toEqual([
            { ordinal: 0, text: 'buy milk', checked: false, depth: 0 },
            { ordinal: 1, text: 'call the bank', checked: true, depth: 0 },
            { ordinal: 2, text: 'book the flight', checked: false, depth: 0 },
        ]);
    });

    // The ordinal is the address the todo index navigates by, and the locator
    // that resolves it walks the document the same depth-first way. A nested
    // item is numbered where it is read, not after its whole parent.
    it('numbers a nested todo depth-first and records how deep it is', () => {
        const d = doc(
            taskList(
                task(false, 'plan the trip', taskList(task(true, 'pick dates'))),
                task(false, 'pack'),
            ),
        );
        expect(extractDocumentIndex(d).todos).toEqual([
            { ordinal: 0, text: 'plan the trip', checked: false, depth: 0 },
            { ordinal: 1, text: 'pick dates', checked: true, depth: 1 },
            { ordinal: 2, text: 'pack', checked: false, depth: 0 },
        ]);
    });

    // `textContent` on the item would return 'plan the trip pick dates', so
    // both rows would read as the parent and neither would be recognisable.
    it("keeps a nested item's text out of its parent's", () => {
        const d = doc(taskList(task(false, 'plan the trip', taskList(task(false, 'pick dates')))));
        expect(extractDocumentIndex(d).todos[0].text).toBe('plan the trip');
    });

    it('normalises whitespace in a todo', () => {
        const d = doc(taskList(task(false, '  spaced    out  ')));
        expect(extractDocumentIndex(d).todos[0].text).toBe('spaced out');
    });

    // An empty item is a real item: it is what a freshly inserted todo looks
    // like. Dropping it would make the index disagree with the note, and the
    // ordinals after it point at the wrong lines.
    it('records a todo with no text yet', () => {
        const d = doc(taskList(task(false, ''), task(false, 'second')));
        const todos = extractDocumentIndex(d).todos;
        expect(todos.map((todo) => todo.text)).toEqual(['', 'second']);
    });

    it('truncates a very long todo', () => {
        const d = doc(taskList(task(false, 'x'.repeat(900))));
        expect(extractDocumentIndex(d).todos[0].text).toHaveLength(500);
    });

    // The counts are derived from the list, so the two cannot drift apart.
    it('keeps the counts in step with the list', () => {
        const d = doc(taskList(task(false, 'one'), task(true, 'two')));
        const index = extractDocumentIndex(d);
        expect(index.todoCount).toBe(index.todos.length);
        expect(index.completedTodoCount).toBe(index.todos.filter((todo) => todo.checked).length);
    });

    it('counts no todos in a document without any', () => {
        const index = extractDocumentIndex(doc(para(t('just prose'))));
        expect(index.todoCount).toBe(0);
        expect(index.completedTodoCount).toBe(0);
    });

    // Image alt text carries the attachment hash, which would pollute the index
    // with 64 hex characters per image.
    it('does not index image alt text', () => {
        const hash = 'a'.repeat(64);
        const d = doc(
            para(t('before')),
            schema.nodes.image.create({ src: `oyot-attachment://${hash}`, alt: `oyot:${hash}` }),
        );
        const index = extractDocumentIndex(d);
        expect(index.text).toBe('before');
        expect(index.text).not.toContain(hash);
    });

    it('handles an empty document', () => {
        const index = extractDocumentIndex(doc(para()));
        expect(index).toEqual({
            text: '',
            linkTargets: [],
            attachmentHashes: [],
            todos: [],
            todoCount: 0,
            completedTodoCount: 0,
        });
    });

    it('ignores a link with no target', () => {
        const d = doc(para(schema.nodes.documentLink.create({ targetId: null, title: 'x' })));
        expect(extractDocumentIndex(d).linkTargets).toEqual([]);
    });
});
