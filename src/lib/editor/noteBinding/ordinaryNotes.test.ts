// @vitest-environment jsdom
//
// A note with nothing unknown in it is read, shown and stored exactly as
// y-tiptap does it, byte for byte, so nothing about it changes with the
// binding. And so is one written by our own writer, which is otherwise only
// used for a note that does hold something: it differs from y-tiptap's where
// that matters and nowhere else.

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import {
    ySyncPluginKey,
    yUndoPluginKey,
    yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap';
import { createContentExtensions } from '../extensions';
import { contentSchema, rootFromYDoc } from '../headlessIndex';
import { REMOTE_ORIGIN } from '../origin';
import { createCollaborationExtension } from '../yjs';
import { insertValues } from './slots';
import { editTo, pick, random } from './testEdits';
import { bytesOf, contentOf, copyOf, el, noteOf, para, text, type Attrs } from './testNotes';

vi.mock('$lib/sync', () => ({ pullAttachmentFromPeers: () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

const LINK = { href: 'https://a.b', target: '_blank', rel: 'nofollow', class: null, title: null };

const run = (words: string, attrs: Attrs): [unknown, Attrs] => [words, attrs];

/** Blocks as the editor writes them, at random. */
function ordinaryBlock(next: () => number, depth = 0): Y.XmlElement {
    const words = () =>
        text(
            `w${Math.floor(next() * 100)}`,
            ...(next() < 0.3 ? [run('bold', { bold: {} })] : []),
            ...(next() < 0.3 ? [run('li🙂nk', { link: LINK })] : []),
        );
    const line = () => {
        const parts: unknown[] = next() < 0.15 ? [] : [words()];
        if (next() < 0.3) parts.push(el('tag', { name: 'work' }));
        if (next() < 0.2) parts.push(words());
        return el('paragraph', next() < 0.2 ? { indent: 1 } : {}, ...parts);
    };
    const inner = () => (depth < 2 ? ordinaryBlock(next, depth + 1) : line());
    const cell = () => el('tableCell', { colspan: 1, rowspan: 1 }, line());
    return pick(next, [
        line,
        line,
        line,
        () => el('heading', { level: 2 }, words()),
        () => el('blockquote', {}, inner(), inner()),
        () => el('bulletList', {}, el('listItem', {}, line(), inner()), el('listItem', {}, line())),
        () => el('taskList', {}, el('taskItem', { checked: next() < 0.5 }, line())),
        () => el('codeBlock', { language: 'js' }, text('a\nb')),
        () => el('horizontalRule'),
        () =>
            el('table', {}, el('tableRow', {}, cell(), cell()), el('tableRow', {}, cell(), cell())),
    ])();
}

/** An editor on a copy of `ydoc`, writing as the same client as every other. */
function editorOn(ydoc: Y.Doc, kind: 'y-tiptap' | 'ours' | 'our writer') {
    const copy = new Y.Doc();
    copy.clientID = 7;
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [
            ...createContentExtensions(),
            kind === 'y-tiptap'
                ? Collaboration.configure({ document: copy, field: 'content' })
                : createCollaborationExtension(copy),
        ],
    });
    const { binding } = ySyncPluginKey.getState(editor.state);
    if (kind === 'our writer') binding.reader.hasUnknown = true;
    editor.setEditable(false);
    editor.setEditable(true);
    return { editor, ydoc: copy, binding };
}

describe('an ordinary note', () => {
    it.each(Array.from({ length: Number(process.env.NOTES ?? 40) }, (_, seed) => seed))(
        'is stored the same, note %i',
        (seed) => {
            const next = random(seed);
            const blocks = Array.from({ length: 1 + Math.floor(next() * 5) }, () =>
                ordinaryBlock(next),
            );
            // With a paragraph last, the editor adds no line of its own, which a
            // note holding something unknown is not written for.
            const note = noteOf(...blocks, para('last'));
            const [theirs, ours, forced] = (['y-tiptap', 'ours', 'our writer'] as const).map(
                (kind) => editorOn(note, kind),
            );
            const all = [theirs, ours, forced];

            // y-tiptap guesses where the selection is once it has shown a
            // change made elsewhere, or one undone (see `restoreSelection`).
            let rendered = false;

            for (let step = 0; step < 12; step++) {
                const before = all.map(({ ydoc }) => bytesOf(ydoc));
                expect(before[1], `stored, step ${step}`).toBe(before[0]);
                expect(before[2], `written by us, step ${step}`).toBe(before[0]);
                const shown = all.map(({ editor }) => editor.state.doc.toJSON());
                expect(shown[1]).toEqual(shown[0]);
                expect(shown[2]).toEqual(shown[0]);
                const selected = all.map(({ editor }) => editor.state.selection.toJSON());
                if (!rendered) expect(selected[1]).toEqual(selected[0]);
                expect(selected[2]).toEqual(selected[1]);

                if (next() < 0.1) {
                    rendered = true;
                    const peer = copyOf(theirs.ydoc);
                    const at = Math.floor(next() * (contentOf(peer).length + 1));
                    insertValues(contentOf(peer), at, [ordinaryBlock(next)]);
                    const update = Y.encodeStateAsUpdate(peer);
                    for (const { ydoc } of all) Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
                } else {
                    const edit = editTo(theirs.editor, next);
                    rendered ||= edit.name === 'undo' || edit.name === 'redo';
                    for (const { editor } of all) edit.make(editor);
                }
                // Yjs groups what is undone by the clock.
                for (const { editor } of all) {
                    yUndoPluginKey.getState(editor.state).undoManager.stopCapturing();
                }
            }
            expect(ours.binding.reader.hasUnknown).toBe(false);
            for (const { editor } of all) editor.destroy();
        },
    );

    const change = (ydoc: Y.Doc, edit: (content: Y.XmlFragment) => void) => {
        const peer = copyOf(ydoc);
        edit(contentOf(peer));
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
    };
    const wordsOf = (content: Y.XmlFragment, block: number) =>
        (content.get(block) as Y.XmlElement).get(0) as Y.XmlText;

    it('keeps the caret in its line when a peer types in one of two alike', () => {
        const { editor, ydoc } = editorOn(noteOf(para('abc'), para('abc')), 'ours');
        editor.commands.setTextSelection(3);
        change(ydoc, (content) => wordsOf(content, 0).insert(3, 'X'));
        expect(editor.state.selection.toJSON()).toMatchObject({ anchor: 3, head: 3 });
        editor.destroy();
    });

    it('keeps the selection when a peer deletes the words its start is in', () => {
        const { editor, ydoc } = editorOn(noteOf(para('abc'), para('def')), 'ours');
        editor.commands.setTextSelection({ from: 3, to: 8 });
        change(ydoc, (content) => wordsOf(content, 0).delete(0, 3));
        expect(editor.state.selection.toJSON()).toMatchObject({ anchor: 1, head: 5 });
        editor.destroy();
    });

    it('is read the same without an editor, and only read', () => {
        for (let seed = 0; seed < 200; seed++) {
            const next = random(1000 + seed);
            const note = noteOf(...Array.from({ length: 4 }, () => ordinaryBlock(next)));
            const before = bytesOf(note);
            const ours = rootFromYDoc(note).toJSON();
            expect(bytesOf(note)).toBe(before);
            expect(ours).toEqual(
                yXmlFragmentToProseMirrorRootNode(contentOf(note), contentSchema()).toJSON(),
            );
        }
    });

    it('is read the same when it is empty', () => {
        const note = noteOf();
        expect(rootFromYDoc(note).toJSON()).toEqual({ type: 'doc' });
        const { editor, ydoc } = editorOn(note, 'ours');
        expect(bytesOf(ydoc)).toBe(bytesOf(note));
        expect(editor.state.doc.childCount).toBe(1);
        editor.destroy();
    });

    // y-tiptap joins texts that stand together, and with three of them joins
    // the third into the second, which it has just deleted.
    it('keeps the words of a line stored in three parts, when it is put back', () => {
        const note = noteOf(para('one ', 'two ', 'three'), para('end'));
        const { editor, ydoc } = editorOn(note, 'ours');
        editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
        editor.commands.undo();
        expect(rootFromYDoc(ydoc).textContent).toBe('one two threeend');
        editor.destroy();
    });
});
