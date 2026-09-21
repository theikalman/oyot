import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { createContentExtensions } from './extensions';
import { indexFromYDoc } from './headlessIndex';

const schema = getSchema(createContentExtensions());

// Build a Y.Doc the way the editor would have, so the test exercises the real
// round trip rather than a hand-built fragment.
function ydocOf(content: unknown[]) {
    return prosemirrorJSONToYDoc(schema, { type: 'doc', content }, 'content');
}

function para(text: string) {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

describe('indexFromYDoc', () => {
    it('reads the text of a document nobody has opened', () => {
        const ydoc = ydocOf([
            {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: 'Groceries' }],
            },
            para('milk and eggs'),
        ]);

        expect(indexFromYDoc(ydoc).text).toBe('Groceries milk and eggs');
    });

    it('counts tasks, including nested ones', () => {
        const task = (text: string, checked: boolean, children: unknown[] = []) => ({
            type: 'taskItem',
            attrs: { checked },
            content: [para(text), ...children],
        });
        const ydoc = ydocOf([
            {
                type: 'taskList',
                content: [
                    task('done', true, [{ type: 'taskList', content: [task('sub', false)] }]),
                    task('open', false),
                ],
            },
        ]);

        const index = indexFromYDoc(ydoc);
        expect(index.todoCount).toBe(3);
        expect(index.completedTodoCount).toBe(1);
    });

    // The todo index page lists documents this device may only ever have
    // received, so the rows behind it have to survive the round trip through
    // the CRDT, not just the editor's own walk.
    it('reads every task item out of a document nobody has opened', () => {
        const task = (text: string, checked: boolean, children: unknown[] = []) => ({
            type: 'taskItem',
            attrs: { checked },
            content: [para(text), ...children],
        });
        const ydoc = ydocOf([
            {
                type: 'taskList',
                content: [
                    task('plan the trip', false, [
                        { type: 'taskList', content: [task('pick dates', true)] },
                    ]),
                    task('pack', false),
                ],
            },
        ]);

        expect(indexFromYDoc(ydoc).todos).toEqual([
            { ordinal: 0, text: 'plan the trip', checked: false, depth: 0 },
            { ordinal: 1, text: 'pick dates', checked: true, depth: 1 },
            { ordinal: 2, text: 'pack', checked: false, depth: 0 },
        ]);
    });

    it('collects outgoing document links', () => {
        const ydoc = ydocOf([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'see ' },
                    { type: 'documentLink', attrs: { targetId: 'other', title: 'Other note' } },
                ],
            },
        ]);

        const index = indexFromYDoc(ydoc);
        expect(index.linkTargets).toEqual(['other']);
        // The link's own title is how the user refers to the other document,
        // so it belongs in the searchable text.
        expect(index.text).toContain('Other note');
    });

    it('reads text out of table cells', () => {
        const cell = (text: string) => ({ type: 'tableCell', content: [para(text)] });
        const ydoc = ydocOf([
            {
                type: 'table',
                content: [{ type: 'tableRow', content: [cell('left'), cell('right')] }],
            },
        ]);

        expect(indexFromYDoc(ydoc).text).toContain('left');
        expect(indexFromYDoc(ydoc).text).toContain('right');
    });

    it('collects the attachments a document still embeds', () => {
        // The only record of which blobs are in use, and the thing orphan
        // collection checks a blob against.
        const hash = 'a'.repeat(64);
        const ydoc = ydocOf([
            { type: 'image', attrs: { src: `oyot-attachment://${hash}`, alt: `oyot:${hash}` } },
        ]);

        expect(indexFromYDoc(ydoc).attachmentHashes).toEqual([hash]);
    });

    // The picker offers a tag because some document was indexed holding it, and
    // most of the corpus arrives by sync rather than being typed here. A tag
    // that did not survive this round trip would be a tag only the device it
    // was coined on could ever offer.
    it('collects the tags on a document nobody has opened', () => {
        const ydoc = ydocOf([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'planning ' },
                    { type: 'tag', attrs: { name: 'holiday' } },
                ],
            },
        ]);

        const index = indexFromYDoc(ydoc);
        expect(index.tags).toEqual(['holiday']);
        expect(index.text).toBe('planning holiday');
    });

    it('returns an empty index for an empty document', () => {
        const ydoc = ydocOf([]);
        expect(indexFromYDoc(ydoc)).toEqual({
            text: '',
            linkTargets: [],
            attachmentHashes: [],
            tags: [],
            todos: [],
            todoCount: 0,
            completedTodoCount: 0,
        });
    });

    it('reads the fragment the editor actually binds to', () => {
        // Bound to a different field name, there is nothing to read. This is
        // the failure that would make every synced document index as empty,
        // silently.
        const ydoc = prosemirrorJSONToYDoc(
            schema,
            { type: 'doc', content: [para('hidden')] },
            'somewhere-else',
        );
        expect(indexFromYDoc(ydoc).text).toBe('');
    });
});
