import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import type { Selection, Transaction } from '@tiptap/pm/state';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        indent: {
            /** Move the paragraphs and headings the selection touches one step in. */
            indent: () => ReturnType;
            /** Move them one step back out. */
            outdent: () => ReturnType;
        };
    }
}

/** How many steps in a paragraph or heading can go. */
export const MAX_INDENT = 8;

// What can be indented: a paragraph or a heading, and only one that stands
// on its own in the note or in a quote. A list item's paragraph moves with
// its item, which Tab already nests, and a table cell's stays in its cell.
const INDENTABLE = new Set(['paragraph', 'heading']);
const CONTAINERS = new Set(['doc', 'blockquote']);

/** How many steps in `node` is, 0 for one that is not indented. */
export function indentOf(node: ProseMirrorNode): number {
    return level(node.attrs.indent);
}

// A stored indent as a step from 0 to MAX_INDENT. Anything else, from a
// paste or a document edited by hand, reads as the nearest step there is.
function level(value: unknown): number {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_INDENT) : 0;
}

/** Whether `$pos` is in a paragraph or heading that can be indented. */
export function inIndentable($pos: ResolvedPos): boolean {
    return (
        $pos.depth > 0 &&
        INDENTABLE.has($pos.parent.type.name) &&
        CONTAINERS.has($pos.node($pos.depth - 1).type.name)
    );
}

/** Whether `selection` is a caret at the very start of a block that can be indented. */
export function atIndentableStart(selection: Selection): boolean {
    return selection.empty && selection.$from.parentOffset === 0 && inIndentable(selection.$from);
}

/**
 * Move every paragraph and heading the selection in `tr` touches `by` steps,
 * within 0 and MAX_INDENT. False when that would change none of them.
 * Without `dispatch`, only says whether it would.
 */
export function shiftIndent(tr: Transaction, by: number, dispatch: boolean): boolean {
    const { from, to } = tr.selection;
    const changes: { pos: number; indent: number }[] = [];
    tr.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (!INDENTABLE.has(node.type.name)) return true;
        if (parent && CONTAINERS.has(parent.type.name)) {
            const indent = level(indentOf(node) + by);
            if (indent !== indentOf(node)) changes.push({ pos, indent });
        }
        return false;
    });
    if (changes.length === 0) return false;
    if (dispatch) {
        // Null rather than 0 once a block is back where it started, so it
        // stores nothing, as a block never indented stores nothing.
        for (const { pos, indent } of changes) {
            tr.setNodeAttribute(pos, 'indent', indent === 0 ? null : indent);
        }
    }
    return true;
}

/**
 * Indenting paragraphs and headings a step at a time (ADR 0040): Tab at the
 * start of one moves it in, Shift-Tab moves it back out wherever the caret
 * is, and Backspace at the start of an indented one does too. Over a
 * selection, Tab and Shift-Tab move every block the selection touches.
 *
 * Content, not only interaction: the indent is an attribute of the block,
 * stored with the note and synced. The keys come along because they are
 * part of what an indent is, and harmless where there is no editor to press
 * them in.
 *
 * Above the editor's own keys, at 101, so Backspace outdents before it
 * would join the block to the one above. Tab and Shift-Tab ask nothing of
 * a list or a table, which keep their own meanings for them, and a press
 * this does not take goes on to theirs.
 */
export const Indent = Extension.create({
    name: 'indent',
    priority: 101,

    addGlobalAttributes() {
        return [
            {
                types: [...INDENTABLE],
                attributes: {
                    indent: {
                        // Null, not 0, so a block that is not indented
                        // stores nothing: the collaboration binding writes
                        // every attribute that is not null.
                        default: null,
                        parseHTML: (element) => level(element.getAttribute('data-indent')) || null,
                        // The step is the stylesheet's, which multiplies it
                        // by --indent, so the depth is all a block carries.
                        renderHTML: (attributes) => {
                            const indent = level(attributes.indent);
                            if (indent === 0) return {};
                            return { 'data-indent': String(indent), style: `--indent: ${indent}` };
                        },
                    },
                },
            },
        ];
    },

    addCommands() {
        return {
            indent:
                () =>
                ({ tr, dispatch }) =>
                    shiftIndent(tr, 1, dispatch !== undefined),
            outdent:
                () =>
                ({ tr, dispatch }) =>
                    shiftIndent(tr, -1, dispatch !== undefined),
        };
    },

    addKeyboardShortcuts() {
        return {
            // Only at the start of a block with nothing selected, so Tab in
            // the middle of a sentence still leaves the note, as it does in
            // a text box. Taken there even at the deepest step, so a press
            // that cannot go further does not send the caret away.
            Tab: ({ editor }) => {
                const { selection } = editor.state;
                if (selection.empty) {
                    if (!atIndentableStart(selection)) return false;
                    editor.commands.indent();
                    return true;
                }
                return editor.commands.indent();
            },
            'Shift-Tab': ({ editor }) => editor.commands.outdent(),
            Backspace: ({ editor }) => {
                const { selection } = editor.state;
                if (!atIndentableStart(selection) || indentOf(selection.$from.parent) === 0) {
                    return false;
                }
                return editor.commands.outdent();
            },
        };
    },
});
