import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Lights up, for a moment, the node a jump landed on: the task item a row of
 * the todo index points at. A document opens for reading, where there is no
 * caret to say which line the jump was for.
 *
 * A decoration rather than a class set on the node's element by hand. An
 * editable view watches its DOM and reads what changed back into the
 * document, so a class taken off after the reader had switched to editing
 * redrew the item, possibly under the caret of someone typing in it.
 */

/** Matches the length of the animation in the editor's stylesheet. */
export const JUMP_TARGET_MS = 2000;

const key = new PluginKey<DecorationSet>('jumpTarget');

/** The position of the node to light up, or null to put it out. */
type JumpTargetMeta = { pos: number } | null;

export function jumpTargetPlugin(): Plugin<DecorationSet> {
    return new Plugin<DecorationSet>({
        key,
        state: {
            init: () => DecorationSet.empty,
            apply(tr, lit) {
                const meta = tr.getMeta(key) as JumpTargetMeta | undefined;
                // Kept on the node while the document changes around it.
                if (meta === undefined) return lit.map(tr.mapping, tr.doc);
                if (meta === null) return DecorationSet.empty;
                const node = tr.doc.nodeAt(meta.pos);
                if (!node) return DecorationSet.empty;
                return DecorationSet.create(tr.doc, [
                    Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: 'jump-target' }),
                ]);
            },
        },
        props: {
            decorations: (state) => key.getState(state),
        },
    });
}

export const JumpTarget = Extension.create({
    name: 'jumpTarget',

    addProseMirrorPlugins() {
        return [jumpTargetPlugin()];
    },
});

/** What marking needs of the view, which an EditorView has. */
interface View {
    readonly state: EditorState;
    readonly isDestroyed: boolean;
    dispatch(tr: Transaction): void;
}

/** Light up the node at `pos` until the animation has run. */
export function markJumpTarget(view: View, pos: number): void {
    const on: JumpTargetMeta = { pos };
    view.dispatch(view.state.tr.setMeta(key, on));
    setTimeout(() => {
        if (view.isDestroyed) return;
        const off: JumpTargetMeta = null;
        view.dispatch(view.state.tr.setMeta(key, off));
    }, JUMP_TARGET_MS);
}
