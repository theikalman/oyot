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
