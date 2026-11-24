// @vitest-environment jsdom
//
// Notes of anything at all, edited at random. Whatever the note and the edit,
// nothing in the note goes unless the edit took it out, what is shown is what
// is stored, and nothing is stored that was not edited.

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { createContentExtensions } from '../extensions';
import { rootFromYDoc } from '../headlessIndex';
import { REMOTE_ORIGIN } from '../origin';
import { createCollaborationExtension } from '../yjs';
import { insertValues } from './slots';
import { editTo, pick, random, TAKING } from './testEdits';
import { bytesOf, contentOf, copyOf, el, hook, noteOf, para, stored, text } from './testNotes';

vi.mock('$lib/sync', () => ({ pullAttachmentFromPeers: () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve(null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

/** Blocks of anything, each thing in them this build does not know named apart. */
function anyBlocks(next: () => number) {
    let count = 0;
    const name = () => `U${count++}U`;

    const words = () => {
        const runs: (string | [unknown, Record<string, unknown>])[] = [
            `w${Math.floor(next() * 100)}`,
        ];
        if (next() < 0.4) runs.push(['lit', { highlight: { by: name() } }]);
        if (next() < 0.3) runs.push(['bold', { bold: {} }]);
        return text(...runs);
    };
    const chip = () =>
        pick(next, [
            () => el('mention', { id: name() }),
            () => text('em', [{ embed: name() }], 'bed'),
            () => hook({ is: name() }),
            () => el('tag', { name: 'work' }),
        ])();
    const line = () => {
        const parts: unknown[] = [words()];
        if (next() < 0.4) parts.push(chip());
        if (next() < 0.4) parts.push(words());
        return el('paragraph', {}, ...parts);
    };
    const block = (depth = 0): unknown => {
        const inner = () => (depth < 3 ? block(depth + 1) : line());
        return pick(next, [
            line,
            line,
            line,
            () => el('callout', { kind: name() }, line()),
            () => el('callout', { kind: name() }, line()),
            () => el('blockquote', {}, inner(), inner()),
            () =>
                el(
                    'bulletList',
                    {},
                    el('listItem', {}, line(), inner()),
                    el('listItem', {}, line()),
                ),
            () => el('listItem', {}, line()),
            () => text(name()),
            () => hook({ is: name() }),
            () => (depth === 0 ? name() : line()),
            () => el('bulletList'),
            () => el('taskList', {}, el('taskItem', { checked: false }, line())),
            () => el('codeBlock', {}, words()),
            () => el('heading', { level: 2 }, words()),
        ])();
    };
    return block;
}

const namesIn = (ydoc: Y.Doc) => [...new Set(JSON.stringify(stored(ydoc)).match(/U\d+U/g) ?? [])];

/**
 * A document as it can be compared between two readings of one note: what
 * stands for something is called by the reading, and formatting on a chip is
 * not stored.
 */
function shown(node: Node): unknown {
    return JSON.parse(
        JSON.stringify(node.toJSON(), (key, value) => {
            if (key === 'ref') return undefined;
            return value?.marks && value.type !== 'text' ? { ...value, marks: undefined } : value;
        }),
    );
}

function editorOn(ydoc: Y.Doc): Editor {
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [...createContentExtensions(), createCollaborationExtension(ydoc)],
    });
    editor.setEditable(false);
    editor.setEditable(true);
    return editor;
}

describe('any note', () => {
    it.each(Array.from({ length: Number(process.env.NOTES ?? 40) }, (_, seed) => seed))(
        'keeps what is in it, note %i',
        (seed) => {
            const next = random(seed);
            const block = anyBlocks(next);
            const note = noteOf(
                // Something of the kind, whatever else.
                el('callout', { kind: 'U99999U' }, para('always')),
                ...Array.from({ length: 1 + Math.floor(next() * 5) }, () => block()),
            );
            const before = bytesOf(note);
            rootFromYDoc(note);
            const editor = editorOn(note);
            editor.commands.selectAll();
            expect(bytesOf(note)).toBe(before);

            let held = namesIn(note);
            const steps: string[] = [];
            for (let step = 0; step < 12; step++) {
                let taking = false;
                if (next() < 0.1) {
                    const peer = copyOf(note);
                    const at = Math.floor(next() * (contentOf(peer).length + 1));
                    insertValues(contentOf(peer), at, [block()]);
                    Y.applyUpdate(note, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
                    steps.push('peer');
                } else {
                    const edit = editTo(editor, next);
                    steps.push(edit.name);
                    taking = TAKING.includes(edit.name);
                    edit.make(editor);
                }
                const now = namesIn(note);
                if (!taking) expect(now, steps.join(', ')).toEqual(expect.arrayContaining(held));
                held = now;

                // Opened afresh, it is what is shown here.
                const afresh = editorOn(copyOf(note));
                expect(shown(afresh.state.doc), steps.join(', ')).toEqual(shown(editor.state.doc));
                afresh.destroy();

                if (held.length === 0) break;
                const settled = bytesOf(note);
                editor.commands.setTextSelection(1);
                expect(bytesOf(note), steps.join(', ')).toBe(settled);
            }
            editor.destroy();
        },
    );
});
