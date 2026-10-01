// Where the shortcuts that go somewhere take the user. Worked out here, apart
// from the layout that answers them, so it can be tested.

/** The shortcuts that open a page of the app's, by id, and the page each opens. */
const PAGES = {
    help: '/help',
    search: '/search',
    notes: '/notes',
    journals: '/journals',
    todos: '/todos',
    tags: '/tags',
    settings: '/settings',
} as const;

/** A page a shortcut opens. */
export type Page = (typeof PAGES)[keyof typeof PAGES];

/** Every shortcut that goes somewhere, by id, which is every one the layout answers. */
export const GO_TO_SHORTCUTS: readonly string[] = Object.keys(PAGES);

/** Where the user is when they press one. */
export interface Here {
    /** The path of the page on screen. */
    path: string;
}

/** Where a shortcut takes the user. */
export type Destination = { kind: 'page'; path: Page };

/**
 * Where shortcut `id` takes someone who is `here`, or null when it goes
 * nowhere: they are there already, or it is not one that goes anywhere.
 *
 * Only the page itself is there already. From a page under it, such as one
 * tag's or Sync's, the keys go up to the Tags page or to Settings.
 */
export function destination(id: string, here: Here): Destination | null {
    if (!hasOwn(PAGES, id)) return null;
    const path = PAGES[id];
    return path === here.path ? null : { kind: 'page', path };
}

function hasOwn<T extends object>(object: T, key: string): key is Extract<keyof T, string> {
    return Object.prototype.hasOwnProperty.call(object, key);
}
