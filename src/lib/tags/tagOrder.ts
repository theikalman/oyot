import type { TagSummary } from '$lib/tiptap/tags';

export const TAG_ORDERS = ['name', 'count'] as const;

export type TagOrder = (typeof TAG_ORDERS)[number];

/** How the Tags page lists tags until the user picks something else. */
export const DEFAULT_TAG_ORDER: TagOrder = 'name';

export const TAG_ORDER_LABELS: Record<TagOrder, string> = {
    name: 'Name',
    count: 'Notes count',
};

/** The order a stored value names, or the default when it names none this build knows. */
export function parseTagOrder(value: unknown): TagOrder {
    return TAG_ORDERS.find((order) => order === value) ?? DEFAULT_TAG_ORDER;
}

// As the Notes page sorts titles: "week-2" before "week-10".
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * These tags from A to Z, or most used first with the name breaking a tie, so
 * two tags on the same count do not swap places between renders.
 */
export function sortTags(tags: TagSummary[], order: TagOrder): TagSummary[] {
    const sorted = [...tags];
    if (order === 'count') {
        return sorted.sort(
            (a, b) => b.documentCount - a.documentCount || byName.compare(a.name, b.name),
        );
    }
    return sorted.sort((a, b) => byName.compare(a.name, b.name));
}
