import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import type { Selection, Transaction } from '@tiptap/pm/state';
import { numberOf } from '../attrValues';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        indent: {
            /**
             * Move the paragraphs, headings and lists the selection touches
             * one step in.
             */
            indent: () => ReturnType;
            /** Move them one step back out. */
            outdent: () => ReturnType;
            /**
             * What Tab and Increase indent do: nest a list item under the
             * one above, or where it cannot be, move it in with its whole
             * list, and move anything else that can be indented in a step.
             */
            increaseIndent: () => ReturnType;
            /**
             * What Shift-Tab and Decrease indent do: lift a nested list item
             * out a level, move an indented list or block back a step, and
             * lift an item of a list that is not indented out of its list.
             */
            decreaseIndent: () => ReturnType;
        };
    }
}

/** How many steps in a paragraph, heading or list can go. */
export const MAX_INDENT = 8;

// What can be indented: a paragraph, a heading or a whole list, and only one
// that stands on its own in the note or in a quote. A list item's paragraph
// moves with its item, a nested list with the list it is in, and a table
// cell's paragraph stays in its cell.
const BLOCKS = new Set(['paragraph', 'heading']);
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
const INDENTABLE = new Set([...BLOCKS, ...LISTS]);
const CONTAINERS = new Set(['doc', 'blockquote']);
const ITEMS = ['listItem', 'taskItem'];

/** How many steps in `node` is, 0 for one that is not indented. */
export function indentOf(node: ProseMirrorNode): number {
    return indentStep(node.attrs.indent);
}

/**
 * A stored indent as a step from 0 to MAX_INDENT. Any other number, from a
 * paste or a document edited by hand, reads as the nearest step there is, and
 * anything that is not a number as none.
 */
export function indentStep(value: unknown): number {
    const n = Math.floor(numberOf(value) ?? 0);
    return Math.min(Math.max(n, 0), MAX_INDENT);
}

/** Whether `$pos` is in a paragraph or heading that can be indented. */
export function inIndentable($pos: ResolvedPos): boolean {
    return (
        $pos.depth > 0 &&
        BLOCKS.has($pos.parent.type.name) &&
        CONTAINERS.has($pos.node($pos.depth - 1).type.name)
    );
}

// The depth of the list item nearest `$pos`, or -1 outside a list.
function itemDepth($pos: ResolvedPos): number {
    for (let depth = $pos.depth; depth > 0; depth--) {
        if (ITEMS.includes($pos.node(depth).type.name)) return depth;
    }
    return -1;
}

/** Whether `$pos` is in a list item that is itself inside another item. */
export function inNestedItem($pos: ResolvedPos): boolean {
    const depth = itemDepth($pos);
    return depth >= 2 && ITEMS.includes($pos.node(depth - 2).type.name);
}

/** Whether `$pos` is in an item of a list that can be indented. */
export function inIndentableList($pos: ResolvedPos): boolean {
    for (let depth = $pos.depth; depth > 0; depth--) {
        const name = $pos.node(depth).type.name;
        if (LISTS.has(name) && CONTAINERS.has($pos.node(depth - 1).type.name)) return true;
    }
    return false;
}

/** Whether `selection` is a caret at the very start of a block that can be indented. */
export function atIndentableStart(selection: Selection): boolean {
    return selection.empty && selection.$from.parentOffset === 0 && inIndentable(selection.$from);
}

/**
 * Move every paragraph, heading and list the selection in `tr` touches `by` steps,
 * within 0 and MAX_INDENT. False when that would change none of them.
 * Without `dispatch`, only says whether it would.
 */
export function shiftIndent(tr: Transaction, by: number, dispatch: boolean): boolean {
    const { from, to } = tr.selection;
    const changes: { pos: number; indent: number }[] = [];
    tr.doc.nodesBetween(from, to, (node, pos, parent) => {
        if (!INDENTABLE.has(node.type.name)) return true;
        if (parent && CONTAINERS.has(parent.type.name)) {
            const indent = indentStep(indentOf(node) + by);
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
 * Indenting paragraphs, headings and lists a step at a time (ADR 0040): Tab
 * at the start of a paragraph or heading moves it in, Shift-Tab moves it
 * back out wherever the caret is, and Backspace at the start of an indented
 * one does too. Over a selection, Tab and Shift-Tab move every block the
 * selection touches.
 *
 * In a list, Tab nests the item under the one above, as it always has, and
 * where it cannot, in the first item or the only one, moves the whole list
 * in. It never leaves the note from a list, so a press that can do nothing
 * does not send the caret away.
 *
 * Content, not only interaction: the indent is an attribute of the block,
 * stored with the note and synced. The keys come along because they are
 * part of what an indent is, and harmless where there is no editor to press
 * them in.
 *
 * Above the editor's own keys, at 101, so Backspace outdents before it
 * would join the block to the one above, and Tab in a list is answered here,
 * before the list's own binding. A table keeps Tab: this takes no press in
 * one, and the press goes on to it.
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
                        parseHTML: (element) =>
                            indentStep(element.getAttribute('data-indent')) || null,
                        // The step is the stylesheet's, which multiplies it
                        // by --indent, so the depth is all a block carries.
                        renderHTML: (attributes) => {
                            const indent = indentStep(attributes.indent);
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
            increaseIndent:
                () =>
                ({ commands }) =>
                    commands.first([
                        ...ITEMS.map((item) => () => commands.sinkListItem(item)),
                        () => commands.indent(),
                    ]),
            // A nested item comes out a level before its list moves, and an
            // indented list moves back before its items leave it.
            decreaseIndent:
                () =>
                ({ state, commands }) => {
                    const lift = ITEMS.map((item) => () => commands.liftListItem(item));
                    if (inNestedItem(state.selection.$from)) return commands.first(lift);
                    return commands.first([() => commands.outdent(), ...lift]);
                },
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
                if (inIndentableList(selection.$from)) {
                    editor.commands.increaseIndent();
                    return true;
                }
                if (selection.empty) {
                    if (!atIndentableStart(selection)) return false;
                    editor.commands.indent();
                    return true;
                }
                return editor.commands.indent();
            },
            'Shift-Tab': ({ editor }) => editor.commands.decreaseIndent(),
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
