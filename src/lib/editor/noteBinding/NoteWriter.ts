import * as Y from 'yjs';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isUnknown, UNKNOWN_MARK } from '$lib/tiptap/unknownContent';
import { markKey, undeclaredAttrs, type NoteReader } from './NoteReader';
import { childSlots, insertValues, type SharedType, type Slot } from './slots';
import { deltaOf } from './unknown';

/** A child as Yjs stores one: a node, or the run of text nodes that is one text. */
type Child = ProseMirrorNode | ProseMirrorNode[];

/**
 * Writes the editor's document to a note's Yjs content, for a note holding
 * something this build cannot show. y-tiptap's own writer does it for every
 * other note.
 *
 * This is that writer, with four differences. Without anything unknown to act
 * on, it makes the same changes y-tiptap does, and the tests hold it to that.
 *
 * - What stands for unknown content is matched with it first, and is then left
 *   alone: the blocks on either side of it are compared only with each other.
 *   y-tiptap matches from the two ends of a list and replaces what is between
 *   them, so an edit on both sides of such content would have replaced it.
 * - Content whose placeholder was moved is written again from a copy.
 * - Formatting is written under the name it was stored under.
 * - An attribute the schema has no name for is left where it is.
 */
export class NoteWriter {
    /** Whether unknown content was written somewhere new. */
    rewrote = false;

    constructor(
        private readonly doc: Y.Doc,
        private readonly reader: NoteReader,
        /** y-tiptap's key to transactions of its own. */
        private readonly origin: unknown,
        /** A copy of what a placeholder stands for, or nothing when there is none. */
        private readonly copyOf: (placeholder: ProseMirrorNode) => unknown[],
    ) {}

    write(fragment: Y.XmlFragment, node: ProseMirrorNode): void {
        const { mapping } = this.reader;
        mapping.set(fragment, node);

        if (fragment instanceof Y.XmlElement) {
            const stored = fragment.getAttributes() as Record<string, unknown>;
            const declared = node.type.spec.attrs ?? {};
            for (const [key, value] of Object.entries(node.attrs)) {
                if (value === null) fragment.removeAttribute(key);
                else if (stored[key] !== value) fragment.setAttribute(key, value as string);
            }
            for (const key of Object.keys(stored)) {
                if (node.attrs[key] === undefined && key in declared) fragment.removeAttribute(key);
            }
            this.reader.leaveOut(node, undeclaredAttrs(node.type, stored));
        }

        this.doc.transact(() => {
            this.list(fragment, childSlots(fragment), childrenOf(node), 0, true);
        }, this.origin);
    }

    // --- lists ----------------------------------------------------------------

    /**
     * Make `slots`, which are side by side in `parent` from `start`, say
     * `children`. Stretches of one list are written from its end, so that what
     * was read of the ones before is still so.
     */
    private list(
        parent: Y.XmlFragment,
        slots: Slot[],
        children: Child[],
        start: number,
        whole: boolean,
    ): void {
        const shorter = Math.min(slots.length, children.length);
        let left = 0;
        let right = 0;
        while (left < shorter && this.same(slots[left], children[left])) left++;
        while (
            right + left + 1 < shorter &&
            this.same(slots[slots.length - right - 1], children[children.length - right - 1])
        ) {
            right++;
        }
        const middle = slots.slice(left, slots.length - right);
        const wanted = children.slice(left, children.length - right);

        let toSlot = middle.length;
        let toChild = wanted.length;
        const anchors = this.anchors(middle, wanted);
        for (const [slot, child] of anchors.reverse()) {
            const after = slot + 1;
            this.list(
                parent,
                middle.slice(after, toSlot),
                wanted.slice(child + 1, toChild),
                start + left + after,
                false,
            );
            toSlot = slot;
            toChild = child;
        }
        this.replace(
            parent,
            middle.slice(0, toSlot),
            wanted.slice(0, toChild),
            start + left,
            whole && slots.length === 1,
        );
    }

    /**
     * Which of `slots` and `children` are the same unknown content, or the
     * same block around some, as pairs of indices that rise together.
     */
    private anchors(slots: Slot[], children: Child[]): [number, number][] {
        const places = new Map<unknown, number[]>();
        children.forEach((child, i) => {
            if (Array.isArray(child) || !this.reader.holdsUnknown(child)) return;
            const key = isUnknown(child) ? child.attrs.ref : child;
            const known = places.get(key);
            if (known) known.push(i);
            else places.set(key, [i]);
        });
        if (places.size === 0) return [];

        const pairs: [number, number][] = [];
        slots.forEach((slot, i) => {
            const key = this.reader.isOpaque(slot)
                ? this.reader.ref(slot)
                : this.reader.mapping.get(slot.type!);
            const place = places.get(key)?.shift();
            if (place !== undefined) pairs.push([i, place]);
        });
        return longestRise(pairs);
    }

    /** y-tiptap's comparison of two lists that have nothing unknown in common. */
    private replace(
        parent: Y.XmlFragment,
        slots: Slot[],
        children: Child[],
        start: number,
        only: boolean,
    ): void {
        const { mapping } = this.reader;

        // Unknown content whose placeholder is gone goes first, as the rest of
        // this is for what can be changed into something else.
        const types = slots.filter((slot) => !this.reader.isOpaque(slot)).map((slot) => slot.type!);
        for (const slot of slots.filter((slot) => this.reader.isOpaque(slot)).reverse()) {
            if (slot.type) mapping.delete(slot.type);
            parent.delete(slot.index, 1);
        }

        let left = 0;
        let right = 0;
        // Placeholders that stand for nothing, which take no place in the list.
        let absent = 0;
        const place = () => start + left - absent;

        while (types.length - left - right > 0 && children.length - left - right > 0) {
            const leftType = types[left];
            const leftChild = children[left];
            const rightType = types[types.length - right - 1];
            const rightChild = children[children.length - right - 1];

            if (leftType instanceof Y.XmlText && Array.isArray(leftChild)) {
                if (!this.sameText(leftType, leftChild)) this.writeText(leftType, leftChild);
                left++;
                continue;
            }
            switch (this.closer(leftType, leftChild, rightType, rightChild)) {
                case 'left':
                    this.write(leftType as Y.XmlElement, leftChild as ProseMirrorNode);
                    left++;
                    break;
                case 'right':
                    this.write(rightType as Y.XmlElement, rightChild as ProseMirrorNode);
                    right++;
                    break;
                default: {
                    mapping.delete(leftType);
                    parent.delete(place(), 1);
                    const written = this.insert(parent, place(), [leftChild]);
                    left++;
                    absent += 1 - written;
                }
            }
        }

        const over = types.length - left - right;
        if (only && children.length === 0 && types[0] instanceof Y.XmlText) {
            // Only its words, so that what a peer types in it meanwhile stays.
            mapping.delete(types[0]);
            types[0].delete(0, types[0].length);
        } else if (over > 0) {
            for (const type of types.slice(left, left + over)) mapping.delete(type);
            parent.delete(place(), over);
        }
        if (left + right < children.length) {
            this.insert(parent, place(), children.slice(left, children.length - right));
        }
    }

    /** Which end's element to change into that end's child, if either. */
    private closer(
        leftType: SharedType,
        leftChild: Child,
        rightType: SharedType,
        rightChild: Child,
    ): 'left' | 'right' | null {
        const left = sameName(leftType, leftChild);
        const right = sameName(rightType, rightChild);
        if (!left || !right) return left ? 'left' : right ? 'right' : null;

        const onLeft = this.likeness(leftType as Y.XmlElement, leftChild as ProseMirrorNode);
        const onRight = this.likeness(rightType as Y.XmlElement, rightChild as ProseMirrorNode);
        if (onLeft.mapped !== onRight.mapped) return onLeft.mapped ? 'left' : 'right';
        return onLeft.alike < onRight.alike ? 'right' : 'left';
    }

    private likeness(element: Y.XmlElement, node: ProseMirrorNode) {
        const slots = childSlots(element);
        const children = childrenOf(node);
        const shorter = Math.min(slots.length, children.length);
        let left = 0;
        let right = 0;
        let mapped = false;
        const alike = (slot: Slot, child: Child) => {
            if (this.mappedTo(slot, child)) mapped = true;
            else if (!this.equal(slot, child)) return false;
            return true;
        };
        while (left < shorter && alike(slots[left], children[left])) left++;
        while (
            left + right < shorter &&
            alike(slots[slots.length - right - 1], children[children.length - right - 1])
        ) {
            right++;
        }
        return { alike: left + right, mapped };
    }

    // --- comparing --------------------------------------------------------------

    /** Whether a slot already says `child`, and from now on that it is shown as it. */
    private same(slot: Slot, child: Child): boolean {
        if (this.mappedTo(slot, child)) return true;
        if (!this.equal(slot, child)) return false;
        if (slot.type) this.reader.mapping.set(slot.type, child);
        return true;
    }

    private mappedTo(slot: Slot, child: Child): boolean {
        const mapped = slot.type && this.reader.mapping.get(slot.type);
        if (mapped === undefined) return false;
        // A placeholder says which content it stands for. Two can be one node.
        if (!Array.isArray(child) && isUnknown(child)) return false;
        if (Array.isArray(mapped) && Array.isArray(child)) {
            return mapped.length === child.length && mapped.every((node, i) => node === child[i]);
        }
        return mapped === child;
    }

    private equal(slot: Slot, child: Child): boolean {
        if (!Array.isArray(child) && isUnknown(child)) {
            return this.reader.isOpaque(slot) && this.reader.ref(slot) === child.attrs.ref;
        }
        if (this.reader.isOpaque(slot)) return false;
        if (Array.isArray(child)) {
            return slot.type instanceof Y.XmlText && this.sameText(slot.type, child);
        }
        if (!sameName(slot.type!, child)) return false;
        const element = slot.type as Y.XmlElement;
        const slots = childSlots(element);
        const children = childrenOf(child);
        const attrs = { ...child.attrs, ...this.reader.undeclaredOf(child) };
        return (
            slots.length === children.length &&
            sameAttrs(element.getAttributes(), attrs) &&
            slots.every((inner, i) => this.equal(inner, children[i]))
        );
    }

    private sameText(text: Y.XmlText, nodes: ProseMirrorNode[]): boolean {
        const delta = deltaOf(text);
        return (
            delta.length === nodes.length &&
            delta.every((op, i) => {
                const stored = Object.entries(op.attributes ?? {});
                return (
                    op.insert === nodes[i].text &&
                    stored.length === nodes[i].marks.length &&
                    stored.every(([key, value]) =>
                        nodes[i].marks.some((mark) => sameFormatting(mark, key, value)),
                    )
                );
            })
        );
    }

    // --- writing ------------------------------------------------------------------

    /** Returns how many places in the list what was inserted takes. */
    private insert(parent: Y.XmlFragment, index: number, children: Child[]): number {
        const values = children.flatMap((child) => this.make(child));
        if (values.length > 0) insertValues(parent, index, values);
        return values.length;
    }

    private make(child: Child): unknown[] {
        const { mapping } = this.reader;
        if (Array.isArray(child)) {
            const text = new Y.XmlText();
            text.applyDelta(
                child.map((node) => ({
                    insert: node.text,
                    attributes: this.formatting(node.marks),
                })),
            );
            mapping.set(text, child);
            return [text];
        }
        if (isUnknown(child)) {
            this.rewrote = true;
            const values = this.copyOf(child);
            for (const value of values) {
                if (value instanceof Y.AbstractType) mapping.set(value, child);
            }
            return values;
        }
        const element = new Y.XmlElement(child.type.name);
        for (const [key, value] of Object.entries(child.attrs)) {
            if (value !== null) element.setAttribute(key, value);
        }
        for (const [key, value] of Object.entries(this.reader.undeclaredOf(child))) {
            element.setAttribute(key, value as string);
        }
        insertValues(
            element,
            0,
            childrenOf(child).flatMap((inner) => this.make(inner)),
        );
        mapping.set(element, child);
        return [element];
    }

    private writeText(text: Y.XmlText, nodes: ProseMirrorNode[]): void {
        this.reader.mapping.set(text, nodes);
        const { words, cleared } = storedText(text);
        const content = nodes.map((node) => ({
            insert: node.text!,
            attributes: { ...cleared, ...this.formatting(node.marks) },
        }));
        const { index, remove, insert } = textDiff(words, content.map((c) => c.insert).join(''));
        text.delete(index, remove);
        text.insert(index, insert);
        text.applyDelta(
            content.map(({ insert, attributes }) => ({ retain: insert.length, attributes })),
        );
    }

    /** Marks as a text's formatting, each under the name it is stored by. */
    private formatting(marks: readonly Mark[]): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const mark of marks) {
            if (mark.type.name !== UNKNOWN_MARK) {
                out[mark.type.name] = mark.attrs;
                continue;
            }
            const { name, value } = mark.attrs as { name: string; value: string };
            const key = markKey(name, value);
            // What was read, where it was: Yjs takes it for unchanged.
            out[name] = this.reader.markValues.has(key)
                ? this.reader.markValues.get(key)
                : JSON.parse(value);
        }
        return out;
    }
}

/** A node's children, with the text nodes that stand together as one. */
export function childrenOf(node: ProseMirrorNode): Child[] {
    const out: Child[] = [];
    node.forEach((child) => {
        if (!child.isText) {
            out.push(child);
            return;
        }
        const last = out.at(-1);
        if (Array.isArray(last)) last.push(child);
        else out.push([child]);
    });
    return out;
}

function sameName(type: SharedType, child: Child): boolean {
    return (
        type instanceof Y.XmlElement && !Array.isArray(child) && type.nodeName === child.type.name
    );
}

function sameFormatting(mark: Mark, key: string, value: unknown): boolean {
    if (mark.type.name !== UNKNOWN_MARK) {
        return mark.type.name === key && sameAttrs(value, mark.attrs);
    }
    return mark.attrs.name === key && mark.attrs.value === JSON.stringify(value);
}

/** As y-tiptap compares them: an attribute that is null is one that is not there. */
function sameAttrs(stored: unknown, attrs: unknown): boolean {
    const a = stored as Record<string, unknown>;
    const b = attrs as Record<string, unknown>;
    const keys = Object.keys(a).filter((key) => a[key] !== null);
    if (keys.length !== Object.keys(b).filter((key) => b[key] !== null).length) return false;
    return keys.every(
        (key) =>
            a[key] === b[key] ||
            (isObject(a[key]) && isObject(b[key]) && sameAttrs(a[key], b[key])),
    );
}

function isObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null;
}

/** A text's words, and every formatting in it, to be taken off what does not have it. */
function storedText(text: Y.XmlText): { words: string; cleared: Record<string, null> } {
    let words = '';
    const cleared: Record<string, null> = {};
    for (let item = text._start; item !== null; item = item.right) {
        if (item.deleted) continue;
        if (item.content instanceof Y.ContentString) words += item.content.str;
        else if (item.content instanceof Y.ContentFormat) cleared[item.content.key] = null;
    }
    return { words, cleared };
}

/** The one stretch that differs, never half of a character that is two units. */
function textDiff(from: string, to: string): { index: number; remove: number; insert: string } {
    let left = 0;
    let right = 0;
    while (left < from.length && left < to.length && from[left] === to[left]) left++;
    if (left > 0 && isHigh(from, left - 1)) left--;
    while (
        right + left < from.length &&
        right + left < to.length &&
        from[from.length - right - 1] === to[to.length - right - 1]
    ) {
        right++;
    }
    if (right > 0 && isLow(from, from.length - right)) right--;
    return {
        index: left,
        remove: from.length - left - right,
        insert: to.slice(left, to.length - right),
    };
}

const isHigh = (text: string, i: number) => /[\uD800-\uDBFF]/.test(text[i] ?? '');
const isLow = (text: string, i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? '');

/** The longest run of pairs in which both numbers rise. The first already do. */
function longestRise(pairs: [number, number][]): [number, number][] {
    // ends[n] is the pair that a rise of n + 1 can end on lowest.
    const ends: number[] = [];
    const before: number[] = [];
    pairs.forEach(([, place], i) => {
        let low = 0;
        let high = ends.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (pairs[ends[mid]][1] < place) low = mid + 1;
            else high = mid;
        }
        before[i] = low > 0 ? ends[low - 1] : -1;
        ends[low] = i;
    });
    const out: [number, number][] = [];
    for (let i = ends.at(-1) ?? -1; i >= 0; i = before[i]) out.push(pairs[i]);
    return out.reverse();
}
