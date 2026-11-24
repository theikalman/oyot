// @vitest-environment jsdom
//
// Notes holding what this build has no node or mark for, or that has no
// business being in a note at all, in the editor's real extensions bound to a
// real Y.Doc, and in everything that reads a note without one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { serializeDocument, UNKNOWN_CONTENT } from '$lib/export/markdown';
import { renderNote } from '$lib/mcp/noteMarkdown';
import { toggleTodoInDoc } from '$lib/mcp/todos';
import { editNote, appendToNote } from '$lib/mcp/writes';
import { fakeDeps } from '$lib/mcp/testDocs';
import { renameTagInDoc } from '$lib/tags/renameInDoc';
import { isUnknown, UNKNOWN_MARK } from '$lib/tiptap/unknownContent';
import { createContentExtensions } from '../extensions';
import { indexFromYDoc, rootFromYDoc } from '../headlessIndex';
import { REMOTE_ORIGIN } from '../origin';
import { SelectBeforeDelete } from '../selectBeforeDelete';
import { createCollaborationExtension } from '../yjs';
import { MAX_DEPTH } from './NoteReader';
import { childSlots, insertValues } from './slots';
import { bytesOf, contentOf, copyOf, el, hook, noteOf, para, stored, text } from './testNotes';

vi.mock('$lib/sync', () => ({ pullAttachmentFromPeers: () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

// --- an editor -------------------------------------------------------------

const open: Editor[] = [];
afterEach(() => {
    for (const editor of open.splice(0)) editor.destroy();
});

function openEditor(ydoc: Y.Doc): Editor {
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [
            ...createContentExtensions(),
            createCollaborationExtension(ydoc),
            SelectBeforeDelete,
        ],
    });
    // As EditorInstance opens a note: built editable, and switched to reading.
    editor.setEditable(false);
    open.push(editor);
    return editor;
}

function placeOf(editor: Editor, words: string): number {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text!.includes(words)) found = pos + node.text!.indexOf(words);
    });
    if (found < 0) throw new Error(`"${words}" is not in the note`);
    return found;
}

function type(editor: Editor, after: string, words: string): void {
    const at = placeOf(editor, after) + after.length;
    editor.view.dispatch(editor.state.tr.insertText(words, at));
}

function press(editor: Editor, key: string): void {
    const { view } = editor;
    view.someProp('handleKeyDown', (handle) =>
        handle(view, new KeyboardEvent('keydown', { key, bubbles: true })),
    );
}

/** Where each placeholder is, and the placeholder. */
function placeholders(editor: Editor): { node: Node; pos: number }[] {
    const found: { node: Node; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (isUnknown(node)) found.push({ node, pos });
    });
    return found;
}

const wordsOf = (editor: Editor) =>
    editor.state.doc.textBetween(0, editor.state.doc.content.size, ' ');

// --- what can be in a note ------------------------------------------------------

/** Deeper than is shown, put together from the inside so that Yjs can. */
function nested(depth: number): Y.XmlElement {
    let inner = para('at the bottom');
    for (let i = 0; i < depth; i++) inner = el('blockquote', {}, inner);
    return inner;
}

// Each is the blocks between a first and a last paragraph.
const SHAPES: Record<string, () => unknown[]> = {
    'a block of an unknown type': () => [el('callout', { kind: 'tip' }, para('inside'))],
    'an unknown block with nothing in it': () => [el('chart', { data: { a: [1, 2] } })],
    'an unknown block in a quote': () => [
        el('blockquote', {}, para('before'), el('callout', {}, para('inside')), para('after')),
    ],
    'an unknown block in a table cell': () => [
        el(
            'table',
            {},
            el(
                'tableRow',
                {},
                el('tableCell', {}, para('one'), el('callout', {}, para('inside'))),
                el('tableCell', {}, para('two')),
            ),
        ),
    ],
    'an unknown block in a task': () => [
        el(
            'taskList',
            {},
            el('taskItem', { checked: false }, para('task'), el('callout', {}, para('inside'))),
        ),
    ],
    'an unknown chip in a line': () => [para('a ', el('mention', { id: 7 }, text('Bob')), ' b')],
    'an unknown item in a list': () => [
        el('bulletList', {}, el('listItem', {}, para('item')), el('fancyItem', {}, para('fancy'))),
    ],
    'an unknown mark': () => [
        el('paragraph', {}, text('plain ', ['lit', { highlight: { color: 'red' } }], ' plain')),
    ],
    'an unknown mark in bold': () => [
        el('paragraph', {}, text('plain ', ['lit', { bold: {}, comment: 'c1', size: 3 }])),
    ],
    'a mark that can be on a word twice': () => [
        el(
            'paragraph',
            {},
            text(['lit', { 'comment--abcdefgh': { id: 1 }, 'comment--ijklmnop': {} }]),
        ),
    ],
    'an unknown attribute on a block': () => [el('paragraph', { color: 'red' }, text('coloured'))],
    'an unknown attribute on a mark': () => [
        el('paragraph', {}, text(['link', { link: { href: 'https://a.b', preview: 'big' } }])),
    ],
    'a text among the blocks': () => [text('loose')],
    'an empty text among the blocks': () => [new Y.XmlText()],
    'a text in a quote': () => [el('blockquote', {}, text('loose'), para('quoted'))],
    'a hook among the blocks': () => [hook({ a: 1 })],
    'a hook in a line': () => [para('a ', hook({ a: 1 }), ' b')],
    'a map among the blocks': () => [new Y.Map([['a', 1]])],
    'plain values among the blocks': () => ['raw', 5, null, { a: [1] }, new Uint8Array([1, 2])],
    'plain values in a line': () =>
        [para('a ', 'b')].map((p) => (p.insert(1, ['raw' as never]), p)),
    'an embed in a text': () => [el('paragraph', {}, text('wo', [{ image: 'x' }], 'rds'))],
    'a type embedded in a text': () => [
        el('paragraph', {}, text('wo', [el('mention', {}, text('Bob'))], 'rds')),
    ],
    'a list with no items': () => [el('bulletList')],
    'a list item with no paragraph': () => [
        el(
            'bulletList',
            {},
            el('listItem', {}, el('bulletList', {}, el('listItem', {}, para('x')))),
        ),
    ],
    'a quote with nothing in it': () => [el('blockquote')],
    'a table with no rows': () => [el('table')],
    'a table with no cells': () => [el('table', {}, el('tableRow'), el('tableRow'))],
    'a paragraph in a paragraph': () => [para('outer ', para('inner'))],
    'a list item on its own': () => [el('listItem', {}, para('item'))],
    'a tag on its own': () => [el('tag', { name: 'work' })],
    'bold in a code block': () => [el('codeBlock', {}, text(['code', { bold: {} }]))],
    'a chip in a code block': () => [
        el('codeBlock', {}, text('code'), el('tag', { name: 'work' })),
    ],
    'something in an image': () => [el('image', { src: 'https://a.b/c.png' }, para('x'))],
    'a document in the document': () => [el('doc', {}, para('inside'))],
    'an element that says it is text': () => [el('text', {}, text('inside'))],
    'a placeholder, stored': () => [
        el('unknownBlock', { ref: '1:1', text: 'lies' }),
        para(el('unknownInline', { ref: '1:2' })),
        el('paragraph', {}, text(['lit', { unknownMark: { name: 'bold', value: '{}' } }])),
    ],
    'names that objects have': () => [
        el('constructor', { toString: 'x' }),
        el('__proto__', {}, para('inside')),
        el('paragraph', {}, text(['lit', { hasOwnProperty: {}, __proto__: {} }])),
    ],
    'nesting past what is shown': () => [nested(MAX_DEPTH + 20)],
};

const note = (shape: string) => noteOf(para('first'), ...SHAPES[shape](), para('last'));

describe.each(Object.keys(SHAPES))('a note with %s', (shape) => {
    it('is not changed by reading or indexing it', () => {
        const ydoc = note(shape);
        const before = bytesOf(ydoc);
        let updates = 0;
        ydoc.on('update', () => updates++);

        expect(indexFromYDoc(ydoc).text).toMatch(/^first.*last$/);
        rootFromYDoc(ydoc).check();
        const options = { attachmentPath: () => null, notePath: () => null };
        expect(serializeDocument(rootFromYDoc(ydoc), options)).toMatch(/^first[^]*last\n$/);
        expect(renderNote(rootFromYDoc(ydoc)).markdown).toMatch(/^first[^]*last\n$/);
        toggleTodoInDoc(ydoc, 5, 'no such task', true);

        expect(updates).toBe(0);
        expect(bytesOf(ydoc)).toBe(before);
    });

    it('is not changed by opening it, and opens the same everywhere', () => {
        const ydoc = note(shape);
        const before = bytesOf(ydoc);
        let updates = 0;
        ydoc.on('update', () => updates++);

        const editor = openEditor(ydoc);
        expect(wordsOf(editor)).toMatch(/^first.*last$/);
        expect(() => editor.getHTML()).not.toThrow();
        // Looking around it, and switching to editing and back.
        editor.setEditable(true);
        editor.commands.setTextSelection(3);
        editor.commands.selectAll();
        editor.setEditable(false);

        expect(updates).toBe(0);
        expect(bytesOf(ydoc)).toBe(before);
        expect(editor.state.doc.toJSON()).toEqual(rootFromYDoc(ydoc).toJSON());
        editor.state.doc.check();
    });

    it('keeps it when the rest of the note is edited', () => {
        const ydoc = note(shape);
        const held = childSlots(contentOf(ydoc)).slice(1, -1);
        const before = held.map((slot) => stored(slot.value));
        const editor = openEditor(ydoc);

        type(editor, 'first', ' typed');
        type(editor, 'last', ' typed');
        // Both sides of it at once, which y-tiptap writes as one stretch.
        const { state } = editor;
        editor.view.dispatch(
            state.tr
                .insertText(' again', placeOf(editor, 'last typed') + 10)
                .insertText(' again', placeOf(editor, 'first typed') + 11),
        );
        // Blocks come and go on both sides.
        editor.commands.insertContentAt(0, {
            type: 'paragraph',
            content: [{ type: 'text', text: 'new' }],
        });
        editor
            .chain()
            .setTextSelection(placeOf(editor, 'first') + 3)
            .splitBlock()
            .run();

        const now = childSlots(contentOf(ydoc));
        const keys = held.map((slot) => slot.key);
        const still = now.filter((slot) => keys.includes(slot.key));
        expect(still.map((slot) => slot.key)).toEqual(keys);
        expect(still.map((slot) => stored(slot.value))).toEqual(before);
        expect(now.at(-1)!.value).toBeInstanceOf(Y.XmlElement);
        expect(wordsOf(editor)).toMatch(/^new fir st typed again.*last typed again$/);

        // On the next device, too.
        const reopened = openEditor(copyOf(ydoc));
        expect(reopened.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
    });

    it('takes it when it arrives from a peer, and keeps it', () => {
        const ydoc = noteOf(para('first'), para('last'));
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        editor.commands.setTextSelection(placeOf(editor, 'last') + 2);

        const peer = copyOf(ydoc);
        insertValues(contentOf(peer), 1, SHAPES[shape]());
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
        expect(bytesOf(copyOf(ydoc))).toBe(bytesOf(copyOf(peer)));
        expect(wordsOf(editor)).toMatch(/^first.*last$/);

        type(editor, 'first', ' typed');
        type(editor, 'last', ' typed');
        const held = childSlots(contentOf(ydoc))
            .slice(1, -1)
            .map((slot) => stored(slot.value));
        expect(held).toEqual(
            childSlots(contentOf(peer))
                .slice(1, -1)
                .map((s) => stored(s.value)),
        );
    });

    it('is whole again after it is taken out and that is undone', () => {
        const ydoc = note(shape);
        const before = stored(ydoc);
        const editor = openEditor(ydoc);
        editor.setEditable(true);

        const last = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
        const first = editor.state.doc.firstChild!.nodeSize;
        editor.view.dispatch(editor.state.tr.delete(first, last));
        expect(stored(ydoc)).toEqual(stored(noteOf(para('first'), para('last'))));

        editor.commands.undo();
        expect(stored(ydoc)).toEqual(before);
    });

    it('can be moved', () => {
        const ydoc = note(shape);
        const held = childSlots(contentOf(ydoc))
            .slice(1, -1)
            .map((slot) => stored(slot.value));
        const editor = openEditor(ydoc);
        editor.setEditable(true);

        // As a drag does it: what was taken out, put in somewhere else.
        const { doc, tr } = editor.state;
        const from = doc.firstChild!.nodeSize;
        const to = doc.content.size - doc.lastChild!.nodeSize;
        const moved = doc.slice(from, to).content;
        editor.view.dispatch(tr.delete(from, to).insert(0, moved));

        const now = childSlots(contentOf(ydoc)).map((slot) => stored(slot.value));
        expect(now.slice(0, held.length)).toEqual(held);
        expect(now.slice(held.length)).toEqual(stored(noteOf(para('first'), para('last'))));

        // Once, and not again at every edit after.
        const settled = bytesOf(ydoc);
        editor.commands.setTextSelection(placeOf(editor, 'last') + 1);
        expect(bytesOf(ydoc)).toBe(settled);
        type(editor, 'last', ' typed');
        expect(childSlots(contentOf(ydoc)).length).toBe(held.length + 2);
    });
});

// --- how it is shown ----------------------------------------------------------

describe('what stands for it', () => {
    it('says its words, and can be told apart from them', () => {
        const editor = openEditor(note('a block of an unknown type'));
        const [{ node }] = placeholders(editor);
        expect(node.type.name).toBe('unknownBlock');
        expect(node.attrs.text).toBe('inside');
        const drawn = editor.view.dom.querySelector('.unknown-content')!;
        expect(drawn.textContent).toBe('inside');
        expect(drawn.getAttribute('data-label')).toContain('cannot show');
        expect((drawn as HTMLElement).contentEditable).toBe('false');
    });

    it('leaves words with unknown formatting as words', () => {
        const editor = openEditor(note('an unknown mark in bold'));
        expect(placeholders(editor)).toEqual([]);
        const line = editor.state.doc.child(1);
        expect(line.textContent).toBe('plain lit');
        expect(line.child(1).marks.map((mark) => mark.type.name)).toEqual([
            'bold',
            UNKNOWN_MARK,
            UNKNOWN_MARK,
        ]);
    });

    it('shows a list that is missing what it has to have, with it', () => {
        const ydoc = noteOf(para('first'), el('bulletList'), para('last'));
        const editor = openEditor(ydoc);
        expect(placeholders(editor)).toEqual([]);
        expect(editor.state.doc.child(1).childCount).toBe(1);

        // Stored once there is something in it.
        editor.setEditable(true);
        const list = editor.state.doc.child(0).nodeSize;
        editor.view.dispatch(editor.state.tr.insertText('item', list + 3));
        expect(stored(contentOf(ydoc).get(1))).toEqual(
            stored(
                noteOf(el('bulletList', {}, el('listItem', {}, para('item'))))
                    .getXmlFragment('content')
                    .get(0),
            ),
        );
    });

    it('is one to a block, wherever it is', () => {
        for (const shape of Object.keys(SHAPES)) {
            const ydoc = note(shape);
            expect(rootFromYDoc(ydoc).childCount, shape).toBe(contentOf(ydoc).length);
        }
    });

    it('is there when there is nothing else in the note', () => {
        for (const shape of Object.keys(SHAPES)) {
            const ydoc = noteOf(...SHAPES[shape]());
            const before = bytesOf(ydoc);
            const editor = openEditor(ydoc);
            editor.setEditable(true);
            editor.commands.selectAll();
            expect(bytesOf(ydoc), shape).toBe(before);
            expect(editor.state.doc.childCount).toBeGreaterThanOrEqual(contentOf(ydoc).length);
        }
    });

    it('is selected by the first Backspace or Delete, and taken by the second', () => {
        for (const [key, at] of [
            ['Backspace', (editor: Editor) => placeOf(editor, 'last')],
            ['Delete', (editor: Editor) => placeOf(editor, 'first') + 5],
        ] as const) {
            const ydoc = note('a block of an unknown type');
            const editor = openEditor(ydoc);
            editor.setEditable(true);
            const before = bytesOf(ydoc);
            const { state, view } = editor;
            view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, at(editor))));

            press(editor, key);
            expect(editor.state.selection).toBeInstanceOf(NodeSelection);
            expect(bytesOf(ydoc)).toBe(before);

            press(editor, key);
            expect(stored(ydoc)).toEqual(stored(noteOf(para('first'), para('last'))));
        }
    });
});

// --- editing around it ------------------------------------------------------------

describe('editing right beside it', () => {
    it('keeps a chip through typing on both sides of it, bold, and a split', () => {
        const ydoc = note('an unknown chip in a line');
        const chip = stored((contentOf(ydoc).get(1) as Y.XmlElement).get(1));
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        const [{ pos }] = placeholders(editor);

        editor.view.dispatch(editor.state.tr.insertText('y', pos + 1).insertText('x', pos));
        editor
            .chain()
            .setTextSelection({ from: pos - 1, to: pos + 4 })
            .toggleBold()
            .run();
        const line = contentOf(ydoc).get(1) as Y.XmlElement;
        expect(line.toArray().map(stored)).toEqual([
            [{ insert: 'a' }, { insert: ' x', attributes: { bold: {} } }],
            chip,
            [{ insert: 'y ', attributes: { bold: {} } }, { insert: 'b' }],
        ]);

        // Split before it, so that it is in the line that is new.
        const [{ pos: now }] = placeholders(editor);
        editor.chain().setTextSelection(now).splitBlock().run();
        const lines = contentOf(ydoc).toArray() as Y.XmlElement[];
        expect(lines.flatMap((l) => l.toArray().map(stored))).toContainEqual(chip);
        const settled = bytesOf(ydoc);
        editor.commands.setTextSelection(2);
        expect(bytesOf(ydoc)).toBe(settled);
    });

    it('keeps unknown formatting through typing in it, bold, and a split', () => {
        const ydoc = note('an unknown mark');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        type(editor, 'li', 'mi');
        const lit = placeOf(editor, 'limit');
        editor
            .chain()
            .setTextSelection({ from: lit, to: lit + 2 })
            .toggleBold()
            .run();
        const color = { color: 'red' };
        expect(stored((contentOf(ydoc).get(1) as Y.XmlElement).get(0))).toEqual([
            { insert: 'plain ' },
            { insert: 'li', attributes: { highlight: color, bold: {} } },
            { insert: 'mit', attributes: { highlight: color } },
            { insert: ' plain' },
        ]);

        editor
            .chain()
            .setTextSelection(lit + 3)
            .splitBlock()
            .run();
        const [one, two] = [1, 2].map((i) =>
            stored((contentOf(ydoc).get(i) as Y.XmlElement).get(0)),
        );
        expect(one).toEqual([
            { insert: 'plain ' },
            { insert: 'li', attributes: { highlight: color, bold: {} } },
            { insert: 'm', attributes: { highlight: color } },
        ]);
        expect(two).toEqual([
            { insert: 'it', attributes: { highlight: color } },
            { insert: ' plain' },
        ]);

        // What is typed after it is not formatted as it is.
        editor.commands.setTextSelection(1);
        type(editor, 'it', '!');
        expect(stored((contentOf(ydoc).get(2) as Y.XmlElement).get(0))).toEqual([
            { insert: 'it', attributes: { highlight: color } },
            { insert: '! plain' },
        ]);
    });

    it('keeps an unknown attribute when its own block is typed in, moved or put in a quote', () => {
        const ydoc = note('an unknown attribute on a block');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        type(editor, 'coloured', ' in');
        expect(stored(ydoc)).toMatchObject([{}, { paragraph: { color: 'red' } }, {}]);

        editor.chain().setTextSelection(placeOf(editor, 'coloured')).toggleBlockquote().run();
        expect(stored(contentOf(ydoc).get(1))).toEqual({
            blockquote: {},
            holds: [{ paragraph: { color: 'red' }, holds: [[{ insert: 'coloured in' }]] }],
        });
    });

    it('keeps what is in a block that is taken apart', () => {
        const ydoc = note('an unknown block in a quote');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        // Out of the quote, which leaves the callout in the second half of it.
        editor.chain().setTextSelection(placeOf(editor, 'before')).lift('blockquote').run();
        const callout = {
            callout: {},
            holds: [{ paragraph: {}, holds: [[{ insert: 'inside' }]] }],
        };
        expect(JSON.stringify(stored(ydoc))).toContain(JSON.stringify(callout));
        expect(wordsOf(editor)).toBe('first before after last');
    });

    it('leaves a block holding some alone, where others change on both sides of it', () => {
        // Each line is stored with an attribute or a mark that the editor
        // leaves out, so writing it again would lose it.
        for (const shape of ['an unknown attribute on a block', 'an unknown attribute on a mark']) {
            const ydoc = note(shape);
            const before = stored(contentOf(ydoc).get(1));
            const editor = openEditor(ydoc);
            editor.view.dispatch(
                editor.state.tr
                    .insertText('!', placeOf(editor, 'last') + 4)
                    .insertText('!', placeOf(editor, 'first') + 5),
            );
            expect(stored(contentOf(ydoc).get(1))).toEqual(before);
        }
    });

    it('writes nothing for an empty line the editor adds at the end', () => {
        const ydoc = noteOf(para('first'), el('callout', {}, para('inside')));
        const before = bytesOf(ydoc);
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        editor.commands.setTextSelection(2);
        expect(editor.state.doc.childCount).toBe(3);
        expect(bytesOf(ydoc)).toBe(before);

        type(editor, 'first', ' typed');
        expect(contentOf(ydoc).length).toBe(3);
    });

    it('is taken out with the rest when everything is, first thing', () => {
        const ydoc = note('a block of an unknown type');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        editor.chain().selectAll().deleteSelection().run();
        expect(stored(ydoc)).toEqual([{ paragraph: {}, holds: [[]] }]);
        expect(wordsOf(editor)).toBe('');
    });

    it('survives a peer editing the other half of the note at the same time', () => {
        const ydoc = note('a block of an unknown type');
        const peer = copyOf(ydoc);
        const editor = openEditor(ydoc);
        const theirs = openEditor(peer);
        editor.view.dispatch(
            editor.state.tr
                .insertText(' mine', placeOf(editor, 'last') + 4)
                .insertText(' mine', placeOf(editor, 'first') + 5),
        );
        type(theirs, 'first', ' theirs');
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc), REMOTE_ORIGIN);
        expect(stored(ydoc)).toEqual(stored(peer));
        expect(placeholders(editor).length).toBe(1);
        expect(wordsOf(editor)).toContain('theirs');
        expect(wordsOf(editor)).toContain('mine');
    });

    it('follows what a peer does to it', () => {
        const ydoc = note('a block of an unknown type');
        const editor = openEditor(ydoc);
        const peer = copyOf(ydoc);
        const callout = contentOf(peer).get(1) as Y.XmlElement;
        ((callout.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(6, ' and more');
        callout.setAttribute('kind', 'warning');
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
        expect(placeholders(editor)[0].node.attrs.text).toBe('inside and more');

        // Moved, it is what it is now and not what it was when it was opened.
        editor.setEditable(true);
        const [{ node, pos }] = placeholders(editor);
        editor.view.dispatch(editor.state.tr.delete(pos, pos + 1).insert(0, node));
        expect(stored(contentOf(ydoc).get(0))).toEqual({
            callout: { kind: 'warning' },
            holds: [{ paragraph: {}, holds: [[{ insert: 'inside and more' }]] }],
        });
    });
});

// --- copying it ------------------------------------------------------------------

describe('copying it', () => {
    function copied(editor: Editor, from: number, to: number): string {
        const { view } = editor;
        return view.serializeForClipboard(editor.state.doc.slice(from, to)).dom.innerHTML;
    }

    // jsdom has no ClipboardEvent, and ProseMirror only passes it on.
    const paste = (editor: Editor, html: string) =>
        editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);

    it('pastes as a copy of it in the note it is from', () => {
        const ydoc = note('a block of an unknown type');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        const [{ pos }] = placeholders(editor);
        const html = copied(editor, pos, pos + 1);
        editor.commands.setTextSelection(placeOf(editor, 'last') + 4);
        paste(editor, html);

        const callout = {
            callout: { kind: 'tip' },
            holds: [{ paragraph: {}, holds: [[{ insert: 'inside' }]] }],
        };
        const all = stored(ydoc) as unknown[];
        expect(
            all.filter((block) => JSON.stringify(block) === JSON.stringify(callout)).length,
        ).toBe(2);

        // Two of them, each its own from here on.
        const refs = placeholders(editor).map(({ node }) => node.attrs.ref);
        expect(new Set(refs).size).toBe(2);
        const settled = bytesOf(ydoc);
        editor.commands.setTextSelection(2);
        expect(bytesOf(ydoc)).toBe(settled);
        type(editor, 'first', ' typed');
        expect(placeholders(editor).length).toBe(2);
        expect((stored(ydoc) as unknown[]).length).toBe(all.length);
    });

    it('is kept by cutting it and pasting it', () => {
        const ydoc = note('a block of an unknown type');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        const [{ pos }] = placeholders(editor);
        const html = copied(editor, pos, pos + 1);
        editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
        expect(JSON.stringify(stored(ydoc))).not.toContain('callout');
        editor.commands.setTextSelection(1);
        paste(editor, html);
        expect(JSON.stringify(stored(ydoc))).toContain('"callout":{"kind":"tip"}');
    });

    it('is the words it says in another note, and from a page', () => {
        const from = openEditor(note('a block of an unknown type'));
        const [{ pos }] = placeholders(from);
        const html = copied(from, pos, pos + 1);
        for (const pasted of [html, '<div data-unknown-ref="1:0">inside</div>']) {
            const ydoc = noteOf(para('first'));
            const editor = openEditor(ydoc);
            editor.setEditable(true);
            editor.commands.setTextSelection(6);
            paste(editor, pasted);
            expect(placeholders(editor)).toEqual([]);
            expect(wordsOf(editor)).toContain('inside');
            expect(JSON.stringify(stored(ydoc))).not.toContain('nknown');
        }
    });

    it('carries formatting that is in the note, and no other', () => {
        const ydoc = note('an unknown mark');
        const editor = openEditor(ydoc);
        editor.setEditable(true);
        const lit = placeOf(editor, 'lit');
        const html = copied(editor, lit, lit + 3);
        editor.commands.setTextSelection(placeOf(editor, 'last') + 4);
        paste(editor, html);
        paste(editor, '<span data-unknown-mark="evil" data-unknown-value="{}">page</span>');
        expect(stored(contentOf(ydoc).get(2))).toEqual({
            paragraph: {},
            holds: [
                [
                    { insert: 'last' },
                    { insert: 'lit', attributes: { highlight: { color: 'red' } } },
                    { insert: 'page' },
                ],
            ],
        });
    });
});

// --- reading it without an editor ---------------------------------------------------

describe('an index of it', () => {
    const hash = (c: string) => c.repeat(64);
    const callout = () =>
        el(
            'callout',
            { icon: `oyot-attachment://${hash('a')}`, style: { image: [`oyot:${hash('b')}`] } },
            para(
                'see ',
                el('documentLink', { targetId: 'other', title: 'Other' }),
                ' and ',
                el('tag', { name: 'Work' }),
            ),
            el('image', { src: `oyot-attachment://${hash('c')}` }),
            el('taskList', {}, el('taskItem', { checked: true }, para('hidden task'))),
        );

    it('has the words, links, tags and images in it, and not its tasks', () => {
        const tasks = el('taskList', {}, el('taskItem', { checked: false }, para('shown task')));
        const ydoc = noteOf(para('first'), callout(), tasks);
        const index = indexFromYDoc(ydoc);
        expect(index.text).toBe('first see Other and #work hidden task shown task');
        expect(index.linkTargets).toEqual(['other']);
        expect(index.tags).toEqual(['work']);
        expect(index.attachmentHashes.sort()).toEqual([hash('a'), hash('b'), hash('c')]);
        expect(index.todos).toEqual([{ ordinal: 0, text: 'shown task', checked: false, depth: 0 }]);
    });

    it('numbers the tasks that are shown, and ticks those', () => {
        const tasks = el('taskList', {}, el('taskItem', { checked: false }, para('shown task')));
        const ydoc = noteOf(callout(), tasks);
        expect(toggleTodoInDoc(ydoc, 0, 'shown task', true)).toBe('changed');
        const all = JSON.stringify(stored(ydoc));
        expect(all).toContain(
            '"taskItem":{"checked":true},"holds":[{"paragraph":{},"holds":[[{"insert":"shown task"}]]}]',
        );
        expect(toggleTodoInDoc(ydoc, 0, 'hidden task', false)).toBe('moved');
        expect(toggleTodoInDoc(ydoc, 1, 'hidden task', false)).toBe('moved');
        expect(JSON.stringify(stored(ydoc))).toBe(all);
    });

    it('has a chip in a task as part of what the task says', () => {
        const ydoc = noteOf(
            el(
                'taskList',
                {},
                el(
                    'taskItem',
                    { checked: false },
                    para('ask ', el('mention', {}, text('Bob')), ' back'),
                ),
            ),
        );
        expect(indexFromYDoc(ydoc).todos[0].text).toBe('ask Bob back');
        expect(toggleTodoInDoc(ydoc, 0, 'ask Bob back', true)).toBe('changed');
        expect(JSON.stringify(stored(ydoc))).toContain('"mention":{}');
    });

    it('does not change the open copy', () => {
        const ydoc = note('a block of an unknown type');
        const editor = openEditor(ydoc);
        const before = bytesOf(ydoc);
        let updates = 0;
        ydoc.on('update', () => updates++);
        indexFromYDoc(ydoc);
        expect(updates).toBe(0);
        expect(bytesOf(ydoc)).toBe(before);
        expect(placeholders(editor).length).toBe(1);
    });

    it('is renamed in, as the tags it lists are', () => {
        const ydoc = noteOf(callout());
        expect(renameTagInDoc(ydoc, 'work', 'job')).toBe(1);
        expect(indexFromYDoc(ydoc).tags).toEqual(['job']);
    });
});

describe('an export of it', () => {
    const options = { attachmentPath: () => null, notePath: () => null };
    const markdown = (...blocks: unknown[]) =>
        serializeDocument(rootFromYDoc(noteOf(...blocks)), options);

    it('says there is something there, and what words are in it', () => {
        expect(markdown(el('callout', {}, para('one'), para('two')))).toBe(
            '\\[content this version of Oyot cannot show\\] one two\n',
        );
        expect(markdown(el('chart'))).toBe('\\[content this version of Oyot cannot show\\]\n');
        expect(markdown(para('a ', el('mention', {}, text('Bob')), ' b'))).toBe('a Bob b\n');
        expect(markdown(para('a ', el('mention'), ' b'))).toBe(
            'a \\[content this version of Oyot cannot show\\] b\n',
        );
        const cell = el('tableCell', {}, para('a'), el('callout', {}, para('b')));
        expect(markdown(el('table', {}, el('tableRow', {}, cell)))).toContain('cannot show\\] b |');
    });
});

describe('an assistant editing around it', () => {
    async function edited(ydoc: Y.Doc, change: (markdown: string) => string, accept = false) {
        const { deps } = fakeDeps(new Map([['n', ydoc]]));
        const { markdown } = renderNote(rootFromYDoc(ydoc));
        const { revisionOf } = await import('$lib/mcp/noteMarkdown');
        return editNote('n', change(markdown), await revisionOf(markdown), accept, deps);
    }

    it('leaves it, whatever it is', async () => {
        // Markdown cannot say a quote this deep, so a rewrite is refused.
        const shapes = Object.keys(SHAPES).filter((shape) => !shape.startsWith('nesting'));
        for (const shape of shapes) {
            const ydoc = note(shape);
            const held = childSlots(contentOf(ydoc))
                .slice(1, -1)
                .map((slot) => stored(slot.value));
            const result = await edited(ydoc, (md) =>
                md.replace('first', 'changed').replace(/last\n$/, 'changed too\n'),
            );
            expect(result.status, shape).toBe('changed');
            const now = childSlots(contentOf(ydoc))
                .slice(1, -1)
                .map((slot) => stored(slot.value));
            expect(now, shape).toEqual(held);

            const { deps } = fakeDeps(new Map([['n', ydoc]]));
            await appendToNote('n', 'and more', deps);
            expect(indexFromYDoc(ydoc).text, shape).toMatch(/^changed.*changed too and more$/);
        }
    });

    it('is told before it rewrites or removes it', async () => {
        const drop = (md: string) => md.replace(/^.*cannot show.*\n\n/m, '');
        for (const change of [drop, (md: string) => md.replace('inside', 'outside')]) {
            const ydoc = note('a block of an unknown type');
            const before = bytesOf(ydoc);
            expect(renderNote(rootFromYDoc(ydoc)).markdown).toContain(
                UNKNOWN_CONTENT.replace(/[[\]]/g, '\\$&'),
            );
            const refused = await edited(ydoc, change);
            expect(refused).toMatchObject({
                status: 'lossy',
                lossy: [{ index: 1, losses: ['content this version of Oyot cannot show'] }],
            });
            expect(bytesOf(ydoc)).toBe(before);
            expect((await edited(ydoc, change, true)).status).toBe('changed');
            expect(JSON.stringify(stored(ydoc))).not.toContain('callout');
        }
    });

    it('is told of a chip in a line it rewrites', async () => {
        const ydoc = note('an unknown chip in a line');
        const refused = await edited(ydoc, (md) => md.replace('a Bob b', 'a Bob c'));
        expect(refused).toMatchObject({
            status: 'lossy',
            lossy: [{ losses: ['content this version of Oyot cannot show'] }],
        });
    });
});
