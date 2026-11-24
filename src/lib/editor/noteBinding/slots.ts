import * as Y from 'yjs';

// Any shared type, whatever its events are. Yjs's own types cannot say it
// otherwise: the events are in a parameter that allows no other.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SharedType = Y.AbstractType<any>;

/**
 * One thing in a list of a note's Yjs content, which takes one place in it: a
 * shared type, or a plain value.
 *
 * y-tiptap only ever writes elements and texts. Yjs lets a list hold anything,
 * and a paired device decides what is in it, so nothing here assumes better.
 */
export interface Slot {
    /** Where it is in the list. */
    index: number;
    /**
     * What it is called for as long as it is in the Y.Doc. Its own clock and
     * not its item's: Yjs joins and splits the items that hold plain values.
     */
    key: string;
    value: unknown;
    /** `value`, when it is a shared type. */
    type: SharedType | null;
}

/** What `parent` holds, in order. Reads only. */
export function childSlots(parent: Y.XmlFragment): Slot[] {
    const slots: Slot[] = [];
    for (let item = parent._start; item !== null; item = item.right) {
        if (item.deleted || !item.countable) continue;
        const { client, clock } = item.id;
        item.content.getContent().forEach((value: unknown, i) => {
            slots.push({
                index: slots.length,
                key: `${client}:${clock + i}`,
                value,
                type: value instanceof Y.AbstractType ? value : null,
            });
        });
    }
    return slots;
}

/** The same, without where each one is. */
export function childValues(parent: Y.XmlFragment): unknown[] {
    return childSlots(parent).map((slot) => slot.value);
}

/** Insert what `childValues` gives, which Yjs takes and does not say it does. */
export function insertValues(parent: Y.XmlFragment, index: number, values: unknown[]): void {
    parent.insert(index, values as Y.XmlElement[]);
}
