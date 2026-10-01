import { addDays, journalDateOf, journalTitleFor } from '$lib/calendar/calendar';

// Where the shortcuts that go somewhere take the user: a page of the app's,
// or a day's journal. Worked out here, apart from the layout that answers
// them, so it can be tested.

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

/** The shortcuts that open another day's journal, by id, and how many days on it is. */
const DAY_STEPS = {
    previousDay: -1,
    nextDay: 1,
} as const;

/** Every shortcut that goes somewhere, by id, which is every one the layout answers. */
export const GO_TO_SHORTCUTS: readonly string[] = [
    ...Object.keys(PAGES),
    'today',
    ...Object.keys(DAY_STEPS),
];

/** Where the user is when they press one. */
export interface Here {
    /** The path of the page on screen. */
    path: string;
    /**
     * The title of the journal on screen, or of the one a shortcut is
     * already on its way to, and null on anything else.
     */
    journal: string | null;
}

/**
 * Where a shortcut takes the user: a page, or the journal for a day, by
 * its title, which there may be none of yet.
 */
export type Destination = { kind: 'page'; path: Page } | { kind: 'journal'; title: string };

/**
 * Where shortcut `id` takes someone who is `here` on `today`, or null when
 * it goes nowhere: they are there already, or it is not one that goes
 * anywhere.
 *
 * Only the page itself is there already. From a page under it, such as one
 * tag's or Sync's, the keys go up to the Tags page or to Settings.
 *
 * The day before and the day after are the open journal's, and anywhere
 * else today's, so from a note the day before is yesterday.
 */
export function destination(id: string, here: Here, today: Date): Destination | null {
    if (hasOwn(PAGES, id)) {
        const path = PAGES[id];
        return path === here.path ? null : { kind: 'page', path };
    }

    let title: string;
    if (id === 'today') {
        title = journalTitleFor(today);
    } else if (hasOwn(DAY_STEPS, id)) {
        const from = (here.journal === null ? null : journalDateOf(here.journal)) ?? today;
        title = journalTitleFor(addDays(from, DAY_STEPS[id]));
    } else {
        return null;
    }
    return title === here.journal ? null : { kind: 'journal', title };
}

function hasOwn<T extends object>(object: T, key: string): key is Extract<keyof T, string> {
    return Object.prototype.hasOwnProperty.call(object, key);
}
