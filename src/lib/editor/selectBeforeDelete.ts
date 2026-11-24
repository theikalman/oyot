import { Extension } from '@tiptap/core';
import { NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state';
import { UNKNOWN_BLOCK } from '$lib/tiptap/unknownContent';

/**
 * Backspace at the start of the line after a block this build cannot show, or
 * Delete at the end of the line before one, would take the block at once.
 * Nobody can write it again here, so the first press selects it and the second
 * takes it.
 */
export const SelectBeforeDelete = Extension.create({
    name: 'selectBeforeDelete',

    // Ahead of the editor's own keys, which are what take it.
    priority: 1000,

    addKeyboardShortcuts() {
        const select = (side: -1 | 1) => () => {
            const { state, view } = this.editor;
            const pos = besideCaret(state, side);
            if (pos === null || state.doc.nodeAt(pos)?.type.name !== UNKNOWN_BLOCK) return false;
            const selected = NodeSelection.create(state.doc, pos);
            view.dispatch(state.tr.setSelection(selected).scrollIntoView());
            return true;
        };
        return { Backspace: select(-1), Delete: select(1) };
    },
});

/**
 * Where the block before or after the caret's own begins, when the caret is at
 * that end of its line and the two are side by side. An empty line is left to
 * the editor, which takes the line and selects the block.
 */
function besideCaret(state: EditorState, side: -1 | 1): number | null {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.$cursor) return null;
    const $caret = selection.$cursor;
    const size = $caret.parent.content.size;
    if ($caret.depth === 0 || size === 0) return null;
    if ($caret.parentOffset !== (side < 0 ? 0 : size)) return null;

    const $edge = state.doc.resolve(side < 0 ? $caret.before() : $caret.after());
    const beside = side < 0 ? $edge.nodeBefore : $edge.nodeAfter;
    if (!beside) return null;
    return side < 0 ? $edge.pos - beside.nodeSize : $edge.pos;
}
