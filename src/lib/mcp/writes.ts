// What an assistant can change in a note, done the way the page does it for
// the user (ADR 0037, decisions 7 to 9).
//
// Every change runs inside the document's write queue through
// `editDocument`, so it lands in the open editor when the note is open and is
// saved and sent to paired devices like any other local edit. Creating and
// renaming go through the same actions the sidebar uses, so the lists update
// as they do for a click.

import type * as Y from 'yjs';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { applyEdit } from './applyEdit';
import { parseNote, renderNote, revisionOf, type NoteContext } from './noteMarkdown';
import { planEdit, type EditHunk, type LossyBlock } from './planEdit';
import { toggleTodoInDoc, type TodoToggle } from './todos';

/**
 * The longest note, in bytes of Markdown, that can be rewritten whole. Rust
 * cuts a longer one short when it is read (`MAX_MARKDOWN` in
 * src-tauri/src/mcp/notes.rs), and a rewrite sent back from the cut would
 * delete everything after it.
 */
export const MAX_EDITABLE_BYTES = 200_000;

export interface WriteDeps {
    readDocument<T>(docId: string, read: (ydoc: Y.Doc) => T): Promise<T>;
    editDocument<T>(docId: string, edit: (ydoc: Y.Doc) => T): Promise<T>;
    /** Note titles and tags, read fresh for each write. */
    noteContext(): Promise<NoteContext>;
    createNote(title: string): Promise<{ id: string }>;
    createJournal(date: string): Promise<{ id: string }>;
    renameNote(docId: string, title: string): Promise<{ title: string }>;
}

export type EditResult =
    | { status: 'changed'; revision: string; blocks: number }
    | { status: 'unchanged'; revision: string }
    | { status: 'conflict'; revision: string; markdown: string }
    | { status: 'lossy'; lossy: LossyBlock[] }
    | { status: 'too_long'; bytes: number };

/** The note's Markdown as it stands, and its revision. */
async function current(docId: string, deps: WriteDeps) {
    const markdown = await deps.readDocument(
        docId,
        (ydoc) => renderNote(rootFromYDoc(ydoc)).markdown,
    );
    return { markdown, revision: await revisionOf(markdown) };
}

/**
 * Rewrite a note whole, from the revision the assistant read (decisions 7
 * and 8). The revision is checked twice: against a read before, which is
 * where the hash is worked out, and against the Markdown inside the edit
 * itself, which cannot await, so nothing typed in between is overwritten.
 */
export async function editNote(
    docId: string,
    markdown: string,
    revision: string,
    acceptFormattingLoss: boolean,
    deps: WriteDeps,
): Promise<EditResult> {
    const before = await current(docId, deps);
    if (before.revision !== revision) return { status: 'conflict', ...before };
    const bytes = new TextEncoder().encode(before.markdown).length;
    if (bytes > MAX_EDITABLE_BYTES) return { status: 'too_long', bytes };

    const ctx = await deps.noteContext();
    const outcome = await deps.editDocument(docId, (ydoc) => {
        const root = rootFromYDoc(ydoc);
        if (renderNote(root).markdown !== before.markdown) return { status: 'conflict' } as const;
        const plan = planEdit(root, markdown, ctx);
        if (plan.lossy.length > 0 && !acceptFormattingLoss) {
            return { status: 'lossy', lossy: plan.lossy } as const;
        }
        if (plan.hunks.length === 0) return { status: 'unchanged' } as const;
        applyEdit(ydoc, plan.hunks, root.childCount);
        return { status: 'changed', blocks: changedBlocks(plan.hunks) } as const;
    });

    if (outcome.status === 'lossy') return outcome;
    const after = await current(docId, deps);
    if (outcome.status === 'conflict') return { status: 'conflict', ...after };
    if (outcome.status === 'unchanged') return { status: 'unchanged', revision: after.revision };
    return { status: 'changed', revision: after.revision, blocks: outcome.blocks };
}

/** How many blocks a set of hunks touches, the larger of what goes and what comes. */
function changedBlocks(hunks: EditHunk[]): number {
    return hunks.reduce((n, h) => n + Math.max(h.to - h.from, h.insert.length), 0);
}

/**
 * Add Markdown to the end of a note. A note that is nothing but the one empty
 * paragraph every new note has gets the Markdown instead of it, rather than
 * after a blank line.
 */
export async function appendToNote(
    docId: string,
    markdown: string,
    deps: WriteDeps,
): Promise<{ status: 'changed' | 'unchanged'; revision: string }> {
    const ctx = await deps.noteContext();
    const changed = await deps.editDocument(docId, (ydoc) => {
        const root = rootFromYDoc(ydoc);
        const added: ReturnType<typeof root.child>[] = [];
        parseNote(markdown, ctx).forEach((node) => {
            if (node.type.name !== 'paragraph' || node.content.size > 0) added.push(node);
        });
        if (added.length === 0) return false;
        const blank =
            root.childCount === 1 &&
            root.firstChild!.type.name === 'paragraph' &&
            root.firstChild!.content.size === 0;
        const from = blank ? 0 : root.childCount;
        applyEdit(ydoc, [{ from, to: root.childCount, insert: added }], root.childCount);
        return true;
    });
    const after = await current(docId, deps);
    return { status: changed ? 'changed' : 'unchanged', revision: after.revision };
}

export interface TodoRow {
    ordinal: number;
    text: string;
    checked: boolean;
    depth: number;
}

/** Tick or untick one task (decision 9). A task that moved comes back with the note's tasks as they are. */
export async function toggleTodo(
    docId: string,
    ordinal: number,
    text: string,
    checked: boolean,
    deps: WriteDeps,
): Promise<{ status: TodoToggle; todos?: TodoRow[] }> {
    return deps.editDocument(docId, (ydoc) => {
        const status = toggleTodoInDoc(ydoc, ordinal, text, checked);
        if (status !== 'moved') return { status };
        const todos = extractDocumentIndex(rootFromYDoc(ydoc)).todos.map(
            ({ ordinal, text, checked, depth }) => ({ ordinal, text, checked, depth }),
        );
        return { status, todos };
    });
}

/** A new note, with `markdown` in it when there is any. */
export async function createNoteWith(
    title: string,
    markdown: string,
    deps: WriteDeps,
): Promise<{ id: string; revision: string }> {
    const { id } = await deps.createNote(title);
    if (markdown.trim()) {
        const { revision } = await appendToNote(id, markdown, deps);
        return { id, revision };
    }
    return { id, revision: (await current(id, deps)).revision };
}
