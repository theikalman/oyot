import * as Y from 'yjs';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { MAX_TODO_TEXT, taskItemText } from '$lib/editor/documentIndex';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { locateTaskItem } from '$lib/editor/taskItems';

/**
 * Tick or untick one task in a note's Yjs content (ADR 0037, decision 9).
 *
 * The task is named the way the todo index names it, by its ordinal among
 * the note's task items (ADR 0017), and by what it says. Ordinals are
 * renumbered every time the note is indexed, so a caller holding a stale one
 * could name a different task; the text is how that is caught. Nothing is
 * written then, and the caller is told the task moved.
 *
 * The edit is the `checked` attribute of one element and nothing else, as a
 * tag rename is one `name` (ADR 0020). It is the smallest change that says
 * what happened, two devices ticking the same task resolve as any attribute
 * does, and no Markdown is involved to lose anything.
 *
 * `checked` is what to set, not a flip, so a retried call cannot undo itself.
 *
 * `origin` is left unset, as the tag rename leaves it, so an open editor
 * saves the change like any other local edit.
 */
export type TodoToggle = 'changed' | 'unchanged' | 'moved';

export function toggleTodoInDoc(
    ydoc: Y.Doc,
    ordinal: number,
    expectedText: string,
    checked: boolean,
): TodoToggle {
    const root = rootFromYDoc(ydoc);
    const target = locateTaskItem(root, ordinal);
    const item = target ? root.nodeAt(target.pos) : null;
    if (!item || taskItemText(item) !== normalizeText(expectedText)) return 'moved';
    if (item.attrs.checked === checked) return 'unchanged';

    const element = taskElementAt(ydoc.getXmlFragment(CONTENT_FIELD), ordinal);
    if (!element) return 'moved';
    // y-tiptap stores a node's attributes as they are, so `checked` is a
    // boolean, which Yjs's default typing of attributes as strings does not say.
    const task = element as unknown as Y.XmlElement<{ checked: boolean }>;
    ydoc.transact(() => task.setAttribute('checked', checked));
    return 'changed';
}

/**
 * The `ordinal`th task item element, counted depth first in document order,
 * the order `locateTaskItem` and the index count them in: an item is counted
 * where it is read, before the items nested inside it.
 */
export function taskElementAt(
    parent: Y.XmlFragment | Y.XmlElement,
    ordinal: number,
): Y.XmlElement | null {
    let seen = 0;
    const walk = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
        for (const child of node.toArray()) {
            // Only elements hold elements; a Y.XmlText holds words and marks.
            if (!(child instanceof Y.XmlElement)) continue;
            if (child.nodeName === 'taskItem' && seen++ === ordinal) return child;
            const found = walk(child);
            if (found) return found;
        }
        return null;
    };
    return Number.isInteger(ordinal) && ordinal >= 0 ? walk(parent) : null;
}

/**
 * As `taskItemText` normalises and shortens what it returns, so a todo row's
 * text compares equal, and so does the task's whole text.
 */
function normalizeText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TODO_TEXT);
}
