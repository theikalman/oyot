import * as Y from 'yjs';
import { normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';
import { CONTENT_FIELD } from '$lib/editor/contentField';

/**
 * Rewrite every chip spelling `from` to spell `to`, in place, inside a
 * document's Yjs content.
 *
 * The one place a tag can be renamed. There is no registry to rename in (ADR
 * 0019): a tag exists because documents carry chips saying so, and the chips
 * are the only record, so renaming one means editing every document that has
 * it.
 *
 * This edits the CRDT directly rather than rendering the document to
 * ProseMirror, changing it and writing it back. Re-serialising a document would
 * replace every node in it, which to a peer is "the whole document was
 * rewritten": every concurrent edit anywhere in it would be lost to the
 * replacement, and the update would be the size of the document. Setting one
 * attribute is the smallest edit that says what happened, and Yjs resolves two
 * devices renaming the same chip the way it resolves any attribute, by taking
 * the later one.
 *
 * The mapping is the one y-prosemirror uses: a non-text inline node becomes a
 * `Y.XmlElement` whose `nodeName` is the node type and whose attributes are the
 * node's attributes. A tag chip is therefore an element named `tag` carrying
 * `name`.
 *
 * Returns how many chips were rewritten, so a caller can tell a document that
 * had the tag from one that did not.
 */
export function renameTagInFragment(
    parent: Y.XmlFragment | Y.XmlElement,
    from: string,
    to: string,
): number {
    let changed = 0;
    // A snapshot of the children, because setting an attribute inside the walk
    // is a mutation of the tree being walked.
    for (const child of parent.toArray()) {
        // Before XmlFragment: in Yjs an element *is* a fragment, so the
        // narrower test has to come first or every element takes the branch
        // that only knows how to recurse.
        if (child instanceof Y.XmlElement) {
            if (child.nodeName === TAG_NODE_NAME) {
                if (normalizeTagName(child.getAttribute('name') ?? '') === from) {
                    child.setAttribute('name', to);
                    changed++;
                }
                // An atom: there is nothing inside a chip to walk into.
                continue;
            }
            changed += renameTagInFragment(child, from, to);
        } else if (child instanceof Y.XmlFragment) {
            changed += renameTagInFragment(child, from, to);
        }
        // Anything else is a Y.XmlText, which holds words and marks and can
        // hold no elements, so there is nothing in it to rename.
    }
    return changed;
}

/**
 * The same, over a whole document, as one Yjs transaction.
 *
 * One transaction so the whole rename of one document is one update: a peer
 * sees the document's chips change together, and an open editor re-renders
 * once.
 *
 * `origin` is left unset on purpose. This is a local edit, and the editor's
 * update listener rebroadcasts everything that is not tagged as remote, which
 * is exactly what should happen to a rename made while the document is open.
 */
export function renameTagInDoc(ydoc: Y.Doc, from: string, to: string): number {
    let changed = 0;
    ydoc.transact(() => {
        changed = renameTagInFragment(ydoc.getXmlFragment(CONTENT_FIELD), from, to);
    });
    return changed;
}
