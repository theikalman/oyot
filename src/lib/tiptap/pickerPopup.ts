import type { Editor, Range } from '@tiptap/core';
import { mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import SlashSuggestionPopup, { type PopupItem } from '../components/SlashSuggestionPopup.svelte';

/**
 * The popup a slash command opens when choosing the thing to insert takes a
 * second step: a list, narrowed by typing, chosen with Enter or a click.
 *
 * Shared by the document-link and tag pickers, which are the same widget with
 * different rows. It used to be a hundred and fifty lines inside
 * DocumentLinkCommand, and the second picker would have been a copy of them:
 * two capture-phase key handlers, two click-outside handlers and two unmount
 * paths, each free to leak a listener the other had learned not to.
 *
 * Only one is ever open. Opening closes whatever was open before, which is also
 * what keeps a stale handler from outliving its popup.
 */

export interface PickerOptions {
    /** A hook for styling and for finding it in the DOM. */
    className: string;
    /** Where the caret was, in viewport coordinates. */
    rect: DOMRect;
    /** The rows to show for what has been typed. Called on every keystroke. */
    items: (query: string) => PopupItem[];
    /** A row was chosen, by Enter or by click. */
    onSelect: (id: string) => void;
    /** What to say when `items` returns nothing. */
    emptyLabel?: string;
    /**
     * Closed, however it happened: a choice, Escape, a click elsewhere, or
     * another picker opening. The caller holds the editor and the rows its ids
     * refer to, and without this it has no moment at which to let go of them.
     */
    onClose?: () => void;
}

export interface PickerPopup {
    /** Re-run `items` against the query as it stands, after the data behind it
     * has changed. The open list is what a late-arriving tag list has to reach. */
    refresh(): void;
    close(): void;
}

// Keys are taken on the capture phase, before ProseMirror sees them.
//
// The editor keeps focus while a picker is open, so a bubbling listener ran
// after ProseMirror had already handled the keystroke: Enter split the
// paragraph and then inserted into the new one, and the arrow keys moved the
// caret as well as the selection.
const KEY_CAPTURE = true;

let openPicker: PickerPopup | null = null;

export function closeAnyPicker(): void {
    openPicker?.close();
}

export function openPickerPopup(options: PickerOptions): PickerPopup {
    closeAnyPicker();

    const items = writable<PopupItem[]>([]);
    const selectedIndex = writable(0);
    // What has been typed to narrow the list, shown in the popup so there is
    // some sign of what is being filtered by; the caret is still in the editor.
    const queryStore = writable('');
    let query = '';

    const host = document.createElement('div');
    host.className = options.className;
    host.style.position = 'fixed';
    host.style.left = `${options.rect.left}px`;
    host.style.top = `${options.rect.bottom + 8}px`;
    host.style.zIndex = '1001';
    document.body.appendChild(host);

    function refresh(): void {
        items.set(options.items(query));
        selectedIndex.set(0);
        queryStore.set(query);
    }

    refresh();

    const view = mount(SlashSuggestionPopup, {
        target: host,
        props: {
            items,
            selectedIndex,
            onCommand: choose,
            queryLabel: queryStore,
            emptyLabel: options.emptyLabel,
        },
    });

    let closed = false;

    function close(): void {
        if (closed) return;
        closed = true;
        if (openPicker === picker) openPicker = null;
        document.removeEventListener('keydown', onKeydown, KEY_CAPTURE);
        document.removeEventListener('mousedown', onMouseDown);
        void unmount(view);
        host.remove();
        items.set([]);
        selectedIndex.set(0);
        queryStore.set('');
        options.onClose?.();
    }

    function choose(id: string): void {
        if (closed) return;
        // Selected first, then closed. `onClose` is where the caller lets go of
        // the editor and the rows this id names, so closing first would hand
        // `onSelect` an id it can no longer resolve.
        try {
            options.onSelect(id);
        } finally {
            close();
        }
    }

    function onKeydown(e: KeyboardEvent): void {
        const list = get(items);

        const take = () => {
            e.preventDefault();
            e.stopPropagation();
        };

        if (e.key === 'Escape') {
            take();
            close();
            return;
        }
        if (e.key === 'Backspace') {
            take();
            query = query.slice(0, -1);
            refresh();
            return;
        }
        // A single printable character with no modifier: typing to narrow the
        // list. Taken even when the list is empty, or there would be no way to
        // type past a keystroke that matches nothing towards one that does.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            take();
            query += e.key;
            refresh();
            return;
        }

        // With nothing to choose from, the rest of the keys belong to the
        // editor: arrows would compute a modulo of zero and store NaN, and
        // Enter would claim the keystroke without doing anything.
        if (list.length === 0) return;

        if (e.key === 'ArrowUp') {
            take();
            selectedIndex.update((i) => (i - 1 + list.length) % list.length);
        } else if (e.key === 'ArrowDown') {
            take();
            selectedIndex.update((i) => (i + 1) % list.length);
        } else if (e.key === 'Enter') {
            take();
            const chosen = list[get(selectedIndex)];
            if (chosen) choose(chosen.id);
        }
    }

    function onMouseDown(e: MouseEvent): void {
        if (!host.contains(e.target as Node)) close();
    }

    const picker: PickerPopup = { refresh, close };
    openPicker = picker;

    // Deferred by a tick so the click or keystroke that opened the popup does
    // not immediately close it again.
    setTimeout(() => {
        if (closed) return;
        document.addEventListener('keydown', onKeydown, KEY_CAPTURE);
        document.addEventListener('mousedown', onMouseDown);
    }, 0);

    return picker;
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
