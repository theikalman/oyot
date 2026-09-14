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

    it('returns an empty index for an empty document', () => {
        const ydoc = ydocOf([]);
        expect(indexFromYDoc(ydoc)).toEqual({
            text: '',
            linkTargets: [],
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
