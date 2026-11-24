// Builders shared by this folder's tests: notes as they are stored, put
// together element by element, so that they can hold what the editor never
// writes.
import * as Y from 'yjs';
import { CONTENT_FIELD } from '../contentField';
import { childSlots, insertValues } from './slots';

export type Attrs = Record<string, unknown>;

export function el(name: string, attrs: Attrs = {}, ...children: unknown[]): Y.XmlElement {
    const made = new Y.XmlElement(name);
    // Yjs types an attribute as a string, and stores whatever it is given.
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
    insertValues(made, 0, children);
    return made;
}

/** A text, run by run: words, words with formatting, or something that is not words. */
export function text(...runs: (string | [unknown, Attrs?])[]): Y.XmlText {
    const made = new Y.XmlText();
    made.applyDelta(
        runs.map((run) =>
            typeof run === 'string'
                ? { insert: run }
                : { insert: run[0], attributes: run[1] ?? {} },
        ),
    );
    return made;
}

export const para = (...content: unknown[]) =>
    el('paragraph', {}, ...content.map((part) => (typeof part === 'string' ? text(part) : part)));

export function hook(attrs: Attrs): Y.XmlHook {
    const made = new Y.XmlHook('hook');
    for (const [key, value] of Object.entries(attrs)) made.set(key, value);
    return made;
}

/** A note with `blocks` in it, as it arrives on a device that did not write it. */
export function noteOf(...blocks: unknown[]): Y.Doc {
    const written = new Y.Doc();
    const fragment = written.getXmlFragment(CONTENT_FIELD);
    // One at a time, so that plain values are items of their own.
    for (const block of blocks) insertValues(fragment, fragment.length, [block]);
    return copyOf(written);
}

export function copyOf(ydoc: Y.Doc): Y.Doc {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    return copy;
}

export const bytesOf = (ydoc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('hex');

export const contentOf = (ydoc: Y.Doc) => ydoc.getXmlFragment(CONTENT_FIELD);

/** What is stored, all of it, as something a test can compare. */
export function stored(value: unknown): unknown {
    if (value instanceof Y.Doc) return stored(contentOf(value));
    if (value instanceof Y.XmlElement) {
        const { nodeName } = value;
        return { [nodeName]: value.getAttributes(), holds: childSlots(value).map(storedSlot) };
    }
    if (value instanceof Y.Text) {
        return (value.toDelta() as { insert: unknown }[]).map((op) => ({
            ...op,
            insert: stored(op.insert),
        }));
    }
    if (value instanceof Y.XmlHook) return { hook: value.hookName, ...value.toJSON() };
    if (value instanceof Y.AbstractType && !(value instanceof Y.XmlFragment)) {
        return { type: value.constructor.name, holds: value.toJSON() };
    }
    if (value instanceof Y.XmlFragment) return childSlots(value).map(storedSlot);
    return value;
}

const storedSlot = (slot: { value: unknown }) => stored(slot.value);
