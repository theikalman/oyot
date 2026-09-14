import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { attachmentHash } from '$lib/tiptap/attachmentRef';

/** Everything the todo index page needs about one task item. */
export interface TodoEntry {
    /**
     * Where the item falls among this document's task items, counted
     * depth-first in document order.
     *
     * This is the address the todo index navigates by. The alternative was an
     * id attribute on the node itself, which would mean a schema change, a
     * CRDT write on every document just to mint ids, and two devices minting
     * different ids for the same item. An ordinal is rewritten wholesale on
     * every index pass, so the only way it can be wrong is if the document
     * changed between the index page reading it and the user clicking, which
     * `text` is carried to detect.
     */
    ordinal: number;
    /** The item's own text, excluding any list nested underneath it. */
    text: string;
    checked: boolean;
    /** How many task items this one is nested inside, so the page can indent. */
    depth: number;
}

/** Enough of a task item to recognise it; the rest is a row nobody reads. */
const MAX_TODO_TEXT = 500;

/** Node types that hold nested items rather than this item's own words. */
const LIST_NODES = new Set(['taskList', 'bulletList', 'orderedList']);

// What SQL needs to know about a document that only the editor can see.
//
// Content lives in the CRDT, not in queryable columns, so anything that wants
// to search it, count its todos, or follow its links has to be told. One walk
// of the ProseMirror document on save feeds all three: previously `todo_count`
// was hard-coded to 0, `get_backlinks` had no edge table to consult, and search
// could only match titles.
export interface DocumentIndex {
    /** Plain text, for full-text search. */
    text: string;
    /** Ids of documents this one links to, deduplicated. */
    linkTargets: string[];
    /**
     * Content hashes of the images this document embeds, deduplicated.
     *
     * The only record of which attachments are still in use. Without it,
     * collecting unreferenced blobs has nothing to check a blob against.
     */
    attachmentHashes: string[];
    /**
     * Every task item, in document order.
     *
     * The counts below are derived from this rather than tallied separately,
     * so a list and a count of it cannot disagree.
     */
    todos: TodoEntry[];
    todoCount: number;
    completedTodoCount: number;
}

/**
 * A task item's own text.
 *
 * `textContent` would swallow a nested task list's items into their parent's
 * label, so collection stops at the first child that is a list. Whitespace is
 * normalised because the page renders this on one line.
 */
function taskItemText(node: ProseMirrorNode): string {
    const parts: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (LIST_NODES.has(child.type.name)) break;
        parts.push(child.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_TEXT);
}

/** How many task items enclose the node at `pos`. */
function taskItemDepth(doc: ProseMirrorNode, pos: number): number {
    const $pos = doc.resolve(pos);
    let depth = 0;
    for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.name === 'taskItem') depth++;
    }
    return depth;
}

export function extractDocumentIndex(doc: ProseMirrorNode): DocumentIndex {
    const parts: string[] = [];
    const linkTargets = new Set<string>();
    const attachmentHashes = new Set<string>();
    const todos: TodoEntry[] = [];

    doc.descendants((node, pos) => {
        if (node.isText && node.text) {
            parts.push(node.text);
            return true;
        }

        switch (node.type.name) {
            case 'documentLink': {
                const target = node.attrs.targetId;
                if (typeof target === 'string' && target) linkTargets.add(target);
                // The link's own title is worth matching on: it is how the user
                // refers to the other document from inside this one.
                if (typeof node.attrs.title === 'string' && node.attrs.title) {
                    parts.push(node.attrs.title);
                }
                return false; // atom, nothing inside to walk
            }
            case 'taskItem': {
                todos.push({
                    ordinal: todos.length,
                    text: taskItemText(node),
                    checked: node.attrs.checked === true,
                    depth: taskItemDepth(doc, pos),
                });
                // Carry on into it: its words belong in the search text, and a
                // task list nested inside it holds items of its own.
                return true;
            }
            case 'image': {
                // The hash is what says this attachment is still in use. It is
                // noise in the search text, so it is collected and not pushed
                // into `parts`.
                const hash = attachmentHash(node.attrs.src, node.attrs.alt);
                if (hash) attachmentHashes.add(hash);
                return false;
            }
            default:
                return true;
        }
    });

    // Block boundaries are lost by the walk above, so join on a space: FTS
    // tokenises on whitespace, and gluing the last word of one paragraph to the
    // first of the next would make both unmatchable.
    return {
        text: parts.join(' ').replace(/\s+/g, ' ').trim(),
        linkTargets: [...linkTargets],
        attachmentHashes: [...attachmentHashes],
        todos,
        todoCount: todos.length,
        completedTodoCount: todos.filter((todo) => todo.checked).length,
    };
}
