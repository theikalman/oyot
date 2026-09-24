import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { createContentExtensions } from './extensions';
import { JUMP_TARGET_MS, jumpTargetPlugin, markJumpTarget } from './jumpTarget';
import { locateTaskItem } from './taskItems';

const schema = getSchema(createContentExtensions());

function para(text: string) {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function task(text: string) {
    return { type: 'taskItem', attrs: { checked: false }, content: [para(text)] };
}

// Stands in for an EditorView: what the plugin's state decides is what a view
// would draw, and that is what is under test.
function fakeView() {
    const plugin = jumpTargetPlugin();
    const view = {
        state: EditorState.create({
            schema,
            plugins: [plugin],
            doc: schema.nodeFromJSON({
                type: 'doc',
                content: [
                    para('Before'),
                    { type: 'taskList', content: [task('first'), task('second')] },
                ],
            }),
        }),
        isDestroyed: false,
        dispatch(tr: Transaction) {
            view.state = view.state.apply(tr);
        },
        lit() {
            return (plugin.getState(view.state)?.find() ?? []).map(({ from, to }) => ({
                from,
                to,
            }));
        },
    };
    return view;
}

describe('markJumpTarget', () => {
    let view: ReturnType<typeof fakeView>;

    beforeEach(() => {
        vi.useFakeTimers();
        view = fakeView();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('lights up the whole of the item it is given', () => {
        const { pos } = locateTaskItem(view.state.doc, 1)!;
        const size = view.state.doc.nodeAt(pos)!.nodeSize;

        markJumpTarget(view, pos);

        expect(view.lit()).toEqual([{ from: pos, to: pos + size }]);
    });

    it('goes out once the animation has run', () => {
        markJumpTarget(view, locateTaskItem(view.state.doc, 0)!.pos);

        vi.advanceTimersByTime(JUMP_TARGET_MS - 1);
        expect(view.lit()).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(view.lit()).toEqual([]);
    });

    // A peer's edit can land while the item is lit. The light has to stay on
    // the item rather than on whatever now sits where the item used to be.
    it('stays on the item when text is added above it', () => {
        const { pos } = locateTaskItem(view.state.doc, 1)!;
        const size = view.state.doc.nodeAt(pos)!.nodeSize;
        markJumpTarget(view, pos);

        view.dispatch(view.state.tr.insertText('More ', 1));

        expect(view.lit()).toEqual([{ from: pos + 5, to: pos + 5 + size }]);
    });

    it('leaves the document as it was', () => {
        const before = view.state.doc;

        markJumpTarget(view, locateTaskItem(view.state.doc, 0)!.pos);
        vi.advanceTimersByTime(JUMP_TARGET_MS);

        expect(view.state.doc.eq(before)).toBe(true);
    });

    it('lights nothing for a position with no node after it', () => {
        markJumpTarget(view, view.state.doc.content.size);

        expect(view.lit()).toEqual([]);
    });

    // The note was closed, or switched for another, before the light went
    // out, and a view that is gone cannot take a transaction.
    it('leaves a destroyed view alone', () => {
        markJumpTarget(view, locateTaskItem(view.state.doc, 0)!.pos);
        const dispatch = vi.spyOn(view, 'dispatch');
        view.isDestroyed = true;

        vi.advanceTimersByTime(JUMP_TARGET_MS);

        expect(dispatch).not.toHaveBeenCalled();
    });
});
