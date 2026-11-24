// Edits at random, the same ones every time for a seed, for the tests that
// hold the binding to what it must not do whatever the note and the edit.
import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';

/** Numbers from 0 up to 1, the same for the same seed (mulberry32). */
export function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const pick = <T>(next: () => number, from: readonly T[]): T =>
    from[Math.floor(next() * from.length)];

/** An edit, decided once so that it can be made in more than one editor. */
export interface Edit {
    name: string;
    make: (editor: Editor) => void;
}

/** Every place a caret can be, which is not inside a character. */
function places(doc: Node): number[] {
    const out: number[] = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        const text = node.textBetween(0, node.content.size, null, '-');
        for (let i = 0; i <= node.content.size; i++) {
            if (!/[\uDC00-\uDFFF]/.test(text[i] ?? '')) out.push(pos + 1 + i);
        }
    });
    return out;
}

function startOf(doc: Node, block: number): number {
    let pos = 0;
    for (let i = 0; i < block; i++) pos += doc.child(i).nodeSize;
    return pos;
}

/**
 * An edit to what `editor` shows now. Only those named in `taking` take
 * something out of the note.
 */
export function editTo(editor: Editor, next: () => number): Edit {
    const { doc } = editor.state;
    const carets = places(doc);
    const [a, b] = [pick(next, carets) ?? 0, pick(next, carets) ?? 0];
    const [from, to] = a < b ? [a, b] : [b, a];
    const block = Math.floor(next() * doc.childCount);
    const where = next();

    const edits: Edit[] = [
        { name: 'type', make: (e) => e.view.dispatch(e.state.tr.insertText('T🙂', a)) },
        {
            name: 'type in two places',
            make: (e) => e.view.dispatch(e.state.tr.insertText('A', to).insertText('B', from)),
        },
        { name: 'split', make: (e) => e.chain().setTextSelection(a).splitBlock().run() },
        {
            name: 'move a block',
            make: (e) => {
                const node = e.state.doc.child(block);
                const at = startOf(e.state.doc, block);
                const tr = e.state.tr.delete(at, at + node.nodeSize);
                const place = Math.floor(where * (tr.doc.childCount + 1));
                e.view.dispatch(tr.insert(startOf(tr.doc, place), node));
            },
        },
        { name: 'quote', make: (e) => e.chain().setTextSelection(a).toggleBlockquote().run() },
        { name: 'list', make: (e) => e.chain().setTextSelection(a).toggleBulletList().run() },
        {
            name: 'italic',
            make: (e) => {
                const { italic } = e.state.schema.marks;
                e.view.dispatch(e.state.tr.addMark(from, to, italic.create()));
            },
        },
        { name: 'delete', make: (e) => e.view.dispatch(e.state.tr.delete(from, to)) },
        { name: 'undo', make: (e) => e.commands.undo() },
        { name: 'redo', make: (e) => e.commands.redo() },
    ];
    return pick(next, edits);
}

/** The edits that take something out of the note, or put back a note without it. */
export const TAKING = ['delete', 'undo', 'redo'];
