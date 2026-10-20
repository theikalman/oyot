import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { applyEdit } from './applyEdit';
import { planEdit } from './planEdit';
import { renderNote } from './noteMarkdown';
import { ctx, doc, p, t, ydocOf } from './testDocs';

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const note = doc(...WORDS.map((w) => p(t(w))));

/** Edit a note held in Yjs as an assistant would: read it, rewrite it, apply it. */
function edit(ydoc: Y.Doc, replace: Record<string, string>): void {
    const root = rootFromYDoc(ydoc);
    const markdown = renderNote(root)
        .markdown.split('\n\n')
        .map((block) => replace[block.trim()] ?? block)
        .join('\n\n');
    const plan = planEdit(root, markdown, ctx);
    applyEdit(ydoc, plan.hunks, root.childCount);
}

function words(ydoc: Y.Doc): string[] {
    return renderNote(rootFromYDoc(ydoc)).blocks;
}

/** The Yjs item behind each top-level block, which is what an edit must leave alone. */
function itemIds(ydoc: Y.Doc): string[] {
    return ydoc
        .getXmlFragment(CONTENT_FIELD)
        .toArray()
        .map((child) => {
            const id = (child as Y.XmlElement)._item!.id;
            return `${id.client}:${id.clock}`;
        });
}

describe('applyEdit', () => {
    it('leaves the content exactly as the plan says', () => {
        for (const markdown of [
            'zero\n\none\n\ntwo\n',
            'one\n\n- [ ] new task\n\nthree\n',
            '# all new\n',
            '',
        ]) {
            const ydoc = ydocOf(doc(p(t('one')), p(t('two')), p(t('three'))));
            const root = rootFromYDoc(ydoc);
            const plan = planEdit(root, markdown, ctx);
            applyEdit(ydoc, plan.hunks, root.childCount);
            expect(rootFromYDoc(ydoc).toJSON(), markdown).toEqual(plan.root.toJSON());
        }
    });

    it('leaves the item behind every block it does not change', () => {
        const ydoc = ydocOf(note);
        const before = itemIds(ydoc);
        edit(ydoc, { two: 'TWO', nine: 'NINE' });
        const after = itemIds(ydoc);
        expect(after).toHaveLength(10);
        for (const i of [0, 2, 3, 4, 5, 6, 7, 9]) expect(after[i]).toBe(before[i]);
        expect(after[1]).not.toBe(before[1]);
        expect(after[8]).not.toBe(before[8]);
    });

    it('keeps what another device typed into a block it did not change', () => {
        const a = ydocOf(note);
        const b = new Y.Doc();
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        // A types at the end of block five while B, the assistant, edits
        // blocks one and nine without having seen it.
        const five = a.getXmlFragment(CONTENT_FIELD).get(4) as Y.XmlElement;
        (five.get(0) as Y.XmlText).insert(4, ' and a half');
        edit(b, { one: 'ONE', nine: 'NINE' });

        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        const expected = [...WORDS];
        expected[0] = 'ONE';
        expected[4] = 'five and a half';
        expected[8] = 'NINE';
        expect(words(a)).toEqual(expected);
        expect(words(b)).toEqual(expected);
    });

    it('refuses, and changes nothing, when the note has other blocks than planned', () => {
        const ydoc = ydocOf(note);
        const root = rootFromYDoc(ydoc);
        const plan = planEdit(root, 'just this\n', ctx);
        const before = Y.encodeStateAsUpdate(ydoc);
        expect(() => applyEdit(ydoc, plan.hunks, root.childCount + 1)).toThrow();
        expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    });
});
