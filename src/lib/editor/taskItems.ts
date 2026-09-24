import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** Where a task item sits, and where to put the cursor inside it. */
export interface TaskItemTarget {
    /** Position of the task item node itself. */
    pos: number;
    /** End of the item's own text, which is where a cursor is useful. */
    from: number;
    to: number;
}

/**
 * Find the task item an ordinal names.
 *
 * The other half of the todo index. `extractDocumentIndex` numbers task items
 * as it walks the document depth-first and stores that number; this resolves
 * the number back to a place in the document. The two must walk identically,
 * which is why they live next to each other and are tested against the same
 * nested fixtures: a divergence would land the cursor on the wrong line, and
 * nothing would look broken.
 *
 * Null when there is no such item, which is what a document that has changed
 * since the index page read it looks like.
 */
export function locateTaskItem(doc: ProseMirrorNode, ordinal: number): TaskItemTarget | null {
    if (!Number.isInteger(ordinal) || ordinal < 0) return null;

    let seen = 0;
    let found: TaskItemTarget | null = null;

    doc.descendants((node, pos) => {
        if (found) return false;
        if (node.type.name !== 'taskItem') return true;
        if (seen++ === ordinal) {
            found = { pos, ...cursorRange(node, pos) };
            return false;
        }
        // Carry on into it: a nested list holds items of its own, and they are
        // numbered where they are read.
        return true;
    });

    return found;
}

/**
 * A collapsed cursor at the end of the item's own text.
 *
 * The end rather than the start: the user came here to carry on with this
 * line, and a cursor before the first character is one keystroke from
 * rewriting it.
 */
function cursorRange(item: ProseMirrorNode, pos: number): { from: number; to: number } {
    const first = item.firstChild;
    // `pos + 1` is just inside the item. Everything else is a guess about a
    // shape the schema does not actually guarantee, so it is the fallback.
    const at = first?.isTextblock ? pos + 2 + first.content.size : pos + 1;
    return { from: at, to: at };
}

/**
 * Tick the task item a position is in, or untick it if it was ticked.
 *
 * The innermost item, since items nest: a position inside a sub-task is in
 * its parent task as well, and the box that was clicked is the sub-task's.
 * Null when the position is in no task item at all.
 */
export function toggleTaskAt(state: EditorState, pos: number): Transaction | null {
    const $pos = state.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth);
        if (node.type.name !== 'taskItem') continue;
        return state.tr.setNodeAttribute($pos.before(depth), 'checked', !node.attrs.checked);
    }
    return null;
}
