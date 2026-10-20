// Builders shared by this module's tests: documents in the editor's real
// schema, written as JSON so a test reads as the note it is about.
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { contentSchema } from '$lib/editor/headlessIndex';
import type { NoteContext } from './noteMarkdown';

export const HASH = 'a'.repeat(64);

export const t = (text: string, marks?: unknown[]) =>
    marks ? { type: 'text', text, marks } : { type: 'text', text };
export const p = (...content: unknown[]) =>
    content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
export const h = (level: number, text: string) => ({
    type: 'heading',
    attrs: { level },
    content: [t(text)],
});
export const task = (text: string, checked = false, children: unknown[] = []) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [p(t(text)), ...children],
});
export const tasks = (...items: unknown[]) => ({ type: 'taskList', content: items });
export const image = (attrs: Record<string, unknown>) => ({ type: 'image', attrs });

export function doc(...content: unknown[]): ProseMirrorNode {
    return contentSchema().nodeFromJSON({ type: 'doc', content });
}

export function ydocOf(root: ProseMirrorNode): Y.Doc {
    return prosemirrorJSONToYDoc(contentSchema(), root.toJSON(), CONTENT_FIELD);
}

export const ctx: NoteContext = {
    noteTitle: (id) => ({ n1: 'Kyoto trip', n2: 'Packing' })[id] ?? null,
    knownTags: ['house move', 'travel'],
};

/**
 * The page's side of a write, against documents held in memory: what the
 * repository and the sidebar's actions would do, without Tauri.
 */
export function fakeDeps(docs: Map<string, Y.Doc>) {
    const created: string[] = [];
    const renamed: [string, string][] = [];
    const deps = {
        readDocument: async <T>(id: string, read: (d: Y.Doc) => T) => read(known(docs, id)),
        editDocument: async <T>(id: string, edit: (d: Y.Doc) => T) => edit(known(docs, id)),
        noteContext: async () => ctx,
        createNote: async (title: string) => {
            const id = `new-${created.length + 1}`;
            created.push(title);
            docs.set(id, ydocOf(doc(p())));
            return { id };
        },
        createJournal: async (date: string) => {
            docs.set(date, ydocOf(doc(p())));
            return { id: date };
        },
        renameNote: async (id: string, title: string) => {
            renamed.push([id, title]);
            return { title };
        },
        codec: {
            decode: async () => ({ width: 3000, height: 2000, hasAlpha: false, animated: false }),
            encode: async () => new Uint8Array([1, 2, 3]),
        },
    };
    return { deps, created, renamed };
}

function known(docs: Map<string, Y.Doc>, id: string): Y.Doc {
    const found = docs.get(id);
    if (!found) throw new Error(`no document ${id}`);
    return found;
}
