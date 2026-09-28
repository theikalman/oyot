import type { Content, Editor, Range } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import SlashSuggestionPopup, { type PopupItem } from '../components/SlashSuggestionPopup.svelte';
import { placePopup } from './popupPlacement';
import {
    nextPickerQuery,
    pickerQueryKey,
    type PickerQuery,
    type PickerQueryMeta,
} from './pickerQuery';

/**
 * The popup a slash command opens when choosing the thing to insert takes a
 * second step: a list, narrowed by typing, chosen with Enter or a click.
 *
 * Shared by the document-link and tag pickers, which are the same widget with
 * different rows. It used to be a hundred and fifty lines inside
 * DocumentLinkCommand, and the second picker would have been a copy of them:
 * two key handlers, two click-outside handlers and two unmount paths, each
 * free to leak a listener the other had learned not to.
 *
 * What narrows the list is typed into the note, as it is for the slash menu,
 * and replaced by the choice (see pickerQuery.ts for why it is not read from
 * key events).
 *
 * Only one is ever open. Opening closes whatever was open before, which is also
 * what keeps a stale handler from outliving its popup.
 */

export interface PickerOptions {
    /** The editor typed into to narrow the list, and inserted into. */
    editor: Editor;
    /** A hook for styling and for finding it in the DOM. */
    className: string;
    /** Where the caret was, in viewport coordinates. */
    rect: DOMRect;
    /** The rows to show for what has been typed. Called on every keystroke. */
    items: (query: string) => PopupItem[];
    /**
     * What to put in the note in place of what was typed, for the row chosen
     * by Enter or by click. Null leaves the typed text as it is.
     */
    contentFor: (id: string) => Content;
    /** What to say when `items` returns nothing. */
    emptyLabel?: string;
    /**
     * Closed, however it happened: a choice, Escape, a click elsewhere, the
     * caret leaving what was typed, or another picker opening. The caller
     * holds the rows its ids refer to, and without this it has no moment at
     * which to let go of them.
     */
    onClose?: () => void;
}

export interface PickerPopup {
    /** Re-run `items` against the query as it stands, after the data behind it
     * has changed. The open list is what a late-arriving tag list has to reach. */
    refresh(): void;
    close(): void;
}

// The open picker, as the editor's side of it needs to reach it.
interface OpenPicker {
    view: EditorView;
    keydown(event: KeyboardEvent): boolean;
    follow(typed: PickerQuery | null): void;
    close(): void;
}

let openPicker: OpenPicker | null = null;

export function closeAnyPicker(): void {
    openPicker?.close();
}

/**
 * The editor's side of a picker: it reads what is typed for the open one, and
 * hands it the keys it answers to.
 *
 * The keys come through ProseMirror rather than a listener on the page. Chrome
 * on Android sends Enter as part of what the keyboard is composing, and
 * ProseMirror only recognises it from the paragraph it splits, then offers it
 * here as a key. A listener outside the editor never saw that Enter at all.
 * Handled here, a key the picker takes also never reaches the editor: Enter
 * does not split the paragraph, and the arrows do not move the caret.
 *
 * Every editor that can open a picker needs this; the slash menu carries it.
 */
export function pickerPlugin(editor: Editor): Plugin<PickerQuery | null> {
    return new Plugin<PickerQuery | null>({
        key: pickerQueryKey,
        state: {
            init: () => null,
            apply: (tr, prev, _oldState, state) =>
                nextPickerQuery(tr, prev, state, editor.view.composing),
        },
        props: {
            handleKeyDown: (view, event) =>
                openPicker?.view === view ? openPicker.keydown(event) : false,
        },
        view: () => ({
            update: (view) => {
                if (openPicker?.view === view) {
                    openPicker.follow(pickerQueryKey.getState(view.state) ?? null);
                }
            },
        }),
    });
}

export function openPickerPopup(options: PickerOptions): PickerPopup {
    closeAnyPicker();

    const { editor } = options;
    const items = writable<PopupItem[]>([]);
    const selectedIndex = writable(0);
    let query = '';

    const host = document.createElement('div');
    host.className = options.className;
    host.style.position = 'fixed';
    placePopup(host, options.rect);
    host.style.zIndex = '1001';
    document.body.appendChild(host);

    function refresh(): void {
        items.set(options.items(query));
        selectedIndex.set(0);
    }

    refresh();

    const view = mount(SlashSuggestionPopup, {
        target: host,
        props: {
            items,
            selectedIndex,
            onCommand: choose,
            emptyLabel: options.emptyLabel,
        },
    });

    let closed = false;

    function close(): void {
        if (closed) return;
        closed = true;
        if (openPicker === picker) openPicker = null;
        document.removeEventListener('mousedown', onMouseDown);
        // Stop reading what is typed, unless the editor already has, which
        // it does when the caret moves away or the choice was just inserted.
        if (!editor.isDestroyed && pickerQueryKey.getState(editor.state)) {
            editor.view.dispatch(
                editor.state.tr.setMeta(pickerQueryKey, 'close' satisfies PickerQueryMeta),
            );
        }
        void unmount(view);
        host.remove();
        items.set([]);
        selectedIndex.set(0);
        options.onClose?.();
    }

    function choose(id: string): void {
        if (closed) return;
        const typed = pickerQueryKey.getState(editor.state);
        // Resolved first, then closed. `onClose` is where the caller lets go of
        // the rows this id names, so closing first would hand `contentFor` an
        // id it can no longer resolve.
        try {
            const content = options.contentFor(id);
            if (typed && content !== null) {
                const range: Range = { from: typed.from, to: typed.to };
                editor
                    .chain()
                    .focus()
                    .insertContentAt(range, content)
                    .setMeta(pickerQueryKey, 'close' satisfies PickerQueryMeta)
                    .run();
            }
        } finally {
            close();
        }
    }

    function keydown(e: KeyboardEvent): boolean {
        if (closed) return false;

        if (e.key === 'Escape') {
            close();
            return true;
        }
        // Nothing typed yet: backspace takes back the command that opened the
        // picker, the way backspacing the slash takes back the menu, rather
        // than reaching past it into the note.
        if (e.key === 'Backspace' && query === '') {
            close();
            return true;
        }

        // With nothing to choose from, the rest of the keys belong to the
        // editor: arrows would compute a modulo of zero and store NaN, and
        // Enter would claim the keystroke without doing anything.
        const list = get(items);
        if (list.length === 0) return false;

        if (e.key === 'ArrowUp') {
            selectedIndex.update((i) => (i - 1 + list.length) % list.length);
            return true;
        }
        if (e.key === 'ArrowDown') {
            selectedIndex.update((i) => (i + 1) % list.length);
            return true;
        }
        if (e.key === 'Enter') {
            const chosen = list[get(selectedIndex)];
            if (chosen) choose(chosen.id);
            return true;
        }
        return false;
    }

    // Every change to the editor's state while open. What was typed going
    // away, because the caret left it or a newline ended it, closes the picker;
    // it leaves the text in the note, as dismissing the slash menu does.
    function follow(typed: PickerQuery | null): void {
        if (closed) return;
        if (!typed) {
            close();
            return;
        }
        if (typed.query === query) return;
        query = typed.query;
        refresh();
    }

    function onMouseDown(e: MouseEvent): void {
        if (!host.contains(e.target as Node)) close();
    }

    const picker: OpenPicker = { view: editor.view, keydown, follow, close };
    openPicker = picker;

    // Start reading at the caret. After `openPicker` is set, since the editor
    // reports the start to whichever picker is open.
    editor.view.dispatch(editor.state.tr.setMeta(pickerQueryKey, 'open' satisfies PickerQueryMeta));
    if (pickerQueryKey.getState(editor.state) === undefined) {
        console.error(
            '[picker] the editor has no pickerPlugin, so typing will not narrow the list',
        );
    }

    // Deferred by a tick so the click that opened the popup does not
    // immediately close it again.
    setTimeout(() => {
        if (closed) return;
        document.addEventListener('mousedown', onMouseDown);
    }, 0);

    return { refresh, close };
}

/**
 * Where the caret is on screen, for placing a popup under it.
 *
 * The range the suggestion plugin reports is a document position, and by the
 * time a picker opens the text it covered has been deleted, so the caret is
 * what there is to measure.
 */
export function caretClientRect(editor: Editor, _range?: Range): DOMRect | null {
    try {
        const pos = editor.state.selection.$anchor.pos;
        const coords = editor.view.coordsAtPos(pos);
        return new DOMRect(
            coords.left,
            coords.top,
            coords.right - coords.left,
            coords.bottom - coords.top,
        );
    } catch {
        return null;
    }
}
