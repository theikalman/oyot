// Which order the Notes page lists notes in, as one reactive value, so the
// desktop and phone lists agree and a trip into a note does not lose it.
//
// Kept per device rather than synced, like the size of a window: how one screen
// is arranged says nothing about the notes themselves.

import { DEFAULT_NOTE_ORDER, parseNoteOrder, type NoteOrder } from './noteIndex';

const ORDER_KEY = 'oyot:note-order';

function stored(): NoteOrder {
    try {
        return parseNoteOrder(localStorage.getItem(ORDER_KEY));
    } catch {
        return DEFAULT_NOTE_ORDER;
    }
}

let order = $state<NoteOrder>(stored());

export const noteOrder = {
    get value() {
        return order;
    },
    set value(next: NoteOrder) {
        order = next;
        try {
            localStorage.setItem(ORDER_KEY, next);
        } catch {
            // Private browsing or a locked-down webview. The order still holds
            // until the app closes; only the next launch forgets it.
        }
    },
};
