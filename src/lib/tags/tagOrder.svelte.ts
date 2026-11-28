// Which order the Tags page lists tags in, as one reactive value, so a trip
// into a tag and back does not lose it.
//
// Kept per device rather than synced, as the Notes page's order is.

import { DEFAULT_TAG_ORDER, parseTagOrder, type TagOrder } from './tagOrder';

const ORDER_KEY = 'oyot:tag-order';

function stored(): TagOrder {
    try {
        return parseTagOrder(localStorage.getItem(ORDER_KEY));
    } catch {
        return DEFAULT_TAG_ORDER;
    }
}

let order = $state<TagOrder>(stored());

export const tagOrder = {
    get value() {
        return order;
    },
    set value(next: TagOrder) {
        order = next;
        try {
            localStorage.setItem(ORDER_KEY, next);
        } catch {
            // Private browsing or a locked-down webview. The order still holds
            // until the app closes; only the next launch forgets it.
        }
    },
};
