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
        taskItem: { content: 'paragraph*', attrs: { checked: { default: false } } },
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
const task = (checked: boolean, text: string) =>
    schema.nodes.taskItem.create({ checked }, para(t(text)));

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
        const d = doc(
            schema.nodes.taskList.create(null, [
                task(false, 'one'),
                task(true, 'two'),
                task(true, 'three'),
            ]),
        );
        const index = extractDocumentIndex(d);
        expect(index.todoCount).toBe(3);
        expect(index.completedTodoCount).toBe(2);
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
            todoCount: 0,
            completedTodoCount: 0,
        });
    });

    it('ignores a link with no target', () => {
        const d = doc(para(schema.nodes.documentLink.create({ targetId: null, title: 'x' })));
        expect(extractDocumentIndex(d).linkTargets).toEqual([]);
    });
});
