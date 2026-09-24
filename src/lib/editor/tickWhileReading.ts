import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { toggleTaskAt } from './taskItems';

/**
 * Lets a task be ticked off while its document is being read: the one change
 * reading allows (ADR 0028). Ticking off the day's tasks is much of what
 * reading a journal is for, and pressing Edit for every tick put reading in
 * the way of it.
 *
 * The task item's own box only writes while the editor is editable, and
 * while reading it puts itself straight back. This takes the same change
 * event once it has bubbled up to the editor and makes the tick itself, so
 * the box ends up showing what the document now says.
 */
export const TickWhileReading = Extension.create({
    name: 'tickWhileReading',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    handleDOMEvents: {
                        change: (view, event) => {
                            // Editing, the task item writes the tick itself.
                            if (view.editable) return false;
                            const box = event.target;
                            if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') {
                                return false;
                            }
                            let inside: number;
                            try {
                                // Just inside the item whose box it is.
                                inside = view.posAtDOM(box, 0);
                            } catch {
                                return false;
                            }
                            const tick = toggleTaskAt(view.state, inside);
                            if (!tick) return false;
                            view.dispatch(tick);
                            return true;
                        },
                    },
                },
            }),
        ];
    },
});
