import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { contentSchema } from '$lib/editor/headlessIndex';
import { childSlots } from '$lib/editor/noteBinding/slots';
import type { EditHunk } from './planEdit';

/**
 * Apply an edit's hunks to a note's Yjs content, as one transaction.
 *
 * Each hunk deletes the blocks it covers and inserts new ones in their
 * place; every other block is left as the item it was, so an edit made to it
 * at the same moment on another device, or in the open editor, survives the
 * merge (ADR 0037, decision 7). y-tiptap's `updateYFragment` would do this
 * for the whole note, but it keeps only what matches at the start and the
 * end, so two edits far apart would replace everything between them.
 *
 * Hunks are applied last first, so each one's indices still mean the blocks
 * they were computed against.
 *
 * `origin` is left unset on purpose, as the tag rename leaves it: this is a
 * local edit, and an open editor saves everything not tagged as remote.
 *
 * Throws, and changes nothing, when the content does not have the blocks the
 * plan was made against, which would make every index wrong.
 */
export function applyEdit(ydoc: Y.Doc, hunks: EditHunk[], expectedBlocks: number): void {
    const fragment = ydoc.getXmlFragment(CONTENT_FIELD);
    // A block is a slot, which is one place in the list for anything the
    // editor writes, and can be more for what it does not.
    const blocks = childSlots(fragment);
    if (blocks.length !== expectedBlocks) {
        throw new Error(
            `the note has ${blocks.length} blocks where the edit was planned against ${expectedBlocks}`,
        );
    }
    const place = (block: number) => blocks[block]?.index ?? fragment.length;
    ydoc.transact(() => {
        for (const hunk of [...hunks].reverse()) {
            const from = place(hunk.from);
            if (hunk.to > hunk.from) fragment.delete(from, place(hunk.to) - from);
            if (hunk.insert.length > 0) fragment.insert(from, toYBlocks(hunk));
        }
    });
}

/**
 * The hunk's blocks as Yjs types, ready to insert.
 *
 * Built in a document of their own by y-tiptap, so they are encoded exactly
 * as the editor encodes a block, then cloned: a type belongs to the document
 * it was made in, and a clone is a fresh copy that belongs to none yet.
 */
function toYBlocks(hunk: EditHunk): (Y.XmlElement | Y.XmlText)[] {
    const scratch = new Y.Doc();
    try {
        const built = prosemirrorJSONToYXmlFragment(
            contentSchema(),
            { type: 'doc', content: hunk.insert.map((node) => node.toJSON()) },
            scratch.getXmlFragment(CONTENT_FIELD),
        );
        return built.toArray().map((child) => {
            if (child instanceof Y.XmlElement || child instanceof Y.XmlText) return child.clone();
            throw new Error('y-tiptap built a block that is not an element');
        });
    } finally {
        scratch.destroy();
    }
}
