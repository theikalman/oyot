import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { createContentExtensions } from '$lib/editor/extensions';
import { indexFromYDoc } from '$lib/editor/headlessIndex';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { renameTagInDoc } from './renameInDoc';

// Built the way the editor builds one, so these tests exercise the real
// mapping from ProseMirror nodes to Yjs types rather than a hand-made
// fragment that could be shaped however the test found convenient.
const schema = getSchema(createContentExtensions());

function ydocOf(content: unknown[]) {
    return prosemirrorJSONToYDoc(schema, { type: 'doc', content }, CONTENT_FIELD);
}

const text = (s: string) => ({ type: 'text', text: s });
const tag = (name: string) => ({ type: 'tag', attrs: { name } });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });

/** The tags the indexer reads back out, which is what the tag pages show. */
const tagsOf = (ydoc: Y.Doc) => indexFromYDoc(ydoc).tags;

describe('renameTagInDoc', () => {
    it('rewrites a chip', () => {
        const ydoc = ydocOf([para(text('planning '), tag('holiday'))]);
        expect(renameTagInDoc(ydoc, 'holiday', 'time off')).toBe(1);
        expect(tagsOf(ydoc)).toEqual(['time off']);
    });

    it('rewrites every chip, across blocks', () => {
        const ydoc = ydocOf([para(tag('work')), para(text('and '), tag('work'))]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(2);
        expect(tagsOf(ydoc)).toEqual(['job']);
    });

    it('leaves other tags alone', () => {
        const ydoc = ydocOf([para(tag('work'), tag('home'))]);
        renameTagInDoc(ydoc, 'work', 'job');
        expect(tagsOf(ydoc)).toEqual(['job', 'home']);
    });

    it('leaves the words around it alone', () => {
        const ydoc = ydocOf([para(text('before '), tag('work'), text(' after'))]);
        renameTagInDoc(ydoc, 'work', 'job');
        expect(indexFromYDoc(ydoc).text).toBe('before job after');
    });

    // The walk has to go into every block that can hold inline content, not
    // just the paragraphs at the top. A tag in a task item or a table cell is
    // as real as any other.
    it('finds a chip nested inside a task item', () => {
        const ydoc = ydocOf([
            {
                type: 'taskList',
                content: [
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [para(text('call mum '), tag('urgent'))],
                    },
                ],
            },
        ]);
        expect(renameTagInDoc(ydoc, 'urgent', 'today')).toBe(1);
        expect(tagsOf(ydoc)).toEqual(['today']);
        expect(indexFromYDoc(ydoc).todos[0].text).toBe('call mum #today');
    });

    it('finds a chip nested inside a table cell', () => {
        const ydoc = ydocOf([
            {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [{ type: 'tableCell', content: [para(tag('work'))] }],
                    },
                ],
            },
        ]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(1);
        expect(tagsOf(ydoc)).toEqual(['job']);
    });

    it('reports nothing changed when the document does not carry the tag', () => {
        const ydoc = ydocOf([para(text('nothing here'), tag('home'))]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(0);
        expect(tagsOf(ydoc)).toEqual(['home']);
    });

    it('does nothing to a document with no content at all', () => {
        expect(renameTagInDoc(new Y.Doc(), 'work', 'job')).toBe(0);
    });

    // Running it twice is how a part-finished rename is finished, so the second
    // run must be a no-op rather than a second edit.
    it('is idempotent', () => {
        const ydoc = ydocOf([para(tag('work'))]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(1);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(0);
        expect(tagsOf(ydoc)).toEqual(['job']);
    });

    // A chip written before normalization was tightened, or pasted in, may not
    // be in canonical form. The rename has to find it anyway, or the tag stays
    // in the corpus under a name the user thought they had changed.
    it('matches a chip whose stored name is not normalized', () => {
        const ydoc = ydocOf([para(tag('Work'))]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(1);
        expect(tagsOf(ydoc)).toEqual(['job']);
    });

    // Merging two tags is allowed: it is what renaming onto an existing name
    // means. The document ends up showing the chip twice, and the index counts
    // the tag once, because a document carries a tag or it does not.
    it('merges into a tag the document already has', () => {
        const ydoc = ydocOf([para(tag('work'), text(' '), tag('job'))]);
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(1);
        expect(tagsOf(ydoc)).toEqual(['job']);
    });

    // The whole reason this edits the CRDT rather than re-serialising the
    // document: the update it produces must be the size of the edit, and must
    // not touch anything else, or a peer's concurrent edit is lost to it.
    it('sends a peer the rename, not the document', () => {
        const ydoc = ydocOf([
            para(text('a long paragraph of text to rename inside of '), tag('work')),
        ]);

        // A peer holding the note as it was before the rename.
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

        const before = Y.encodeStateVector(ydoc);
        renameTagInDoc(ydoc, 'work', 'job');
        const delta = Y.encodeStateAsUpdate(ydoc, before);

        // Smaller than the document, which is the whole reason this edits the
        // CRDT rather than re-serialising: a peer that has the note already
        // needs one attribute.
        expect(delta.length).toBeLessThan(Y.encodeStateAsUpdate(ydoc).length);

        Y.applyUpdate(peer, delta);
        expect(tagsOf(peer)).toEqual(['job']);
        expect(indexFromYDoc(peer).text).toBe(indexFromYDoc(ydoc).text);
    });

    // Two devices renaming the same chip differently is an attribute conflict,
    // which Yjs settles on its own. The point here is that both converge, not
    // which spelling wins.
    it('converges when two devices rename the same chip differently', () => {
        const origin = ydocOf([para(tag('work'))]);
        const a = new Y.Doc();
        const b = new Y.Doc();
        Y.applyUpdate(a, Y.encodeStateAsUpdate(origin));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(origin));

        renameTagInDoc(a, 'work', 'job');
        renameTagInDoc(b, 'work', 'career');

        Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        expect(tagsOf(a)).toEqual(tagsOf(b));
        expect(tagsOf(a)).toHaveLength(1);
    });

    // A rename must not clobber what someone else wrote elsewhere in the note
    // while it was happening. This is the case re-serialising the document
    // would fail.
    it('keeps a concurrent edit made elsewhere in the note', () => {
        const origin = ydocOf([para(text('first '), tag('work')), para(text('second'))]);
        const local = new Y.Doc();
        const peer = new Y.Doc();
        Y.applyUpdate(local, Y.encodeStateAsUpdate(origin));
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(origin));

        // The peer types in the second paragraph while we rename in the first.
        const secondParagraph = peer.getXmlFragment(CONTENT_FIELD).get(1) as Y.XmlElement;
        (secondParagraph.get(0) as Y.XmlText).insert(6, ' thoughts');
        renameTagInDoc(local, 'work', 'job');

        Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));

        expect(tagsOf(local)).toEqual(['job']);
        expect(indexFromYDoc(local).text).toBe('first job second thoughts');
    });
});
