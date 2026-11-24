// Content this build cannot show: what is in it, and copies of it.

import * as Y from 'yjs';
import { attachmentHash } from '$lib/tiptap/attachmentRef';
import { normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';
import type { UnknownFindings } from '$lib/tiptap/unknownContent';
import { childValues, insertValues, type Slot } from './slots';

/** Every place an attachment's hash can be written, anywhere in a text. */
const ATTACHMENTS = /(?:oyot-attachment:\/\/|oyot:|attachments\W+)([a-f0-9]{64})/gi;

/** Something still to be looked at. */
interface Look {
    value: unknown;
    /** Whether a text is the note's own words, rather than in an attribute. */
    words?: boolean;
    /** Whether it stands in a line of writing. */
    inLine?: boolean;
}

/**
 * The words in a slot, and what an index has to know it holds.
 *
 * Looked into rather than passed over, because the index is what decides which
 * attachments are still in use: an image in a block only a newer build shows
 * would otherwise be collected here. Tags and links are there because a tag
 * rename edits them, and a link is a link whatever is around it.
 *
 * A list of what is left to look at rather than a function that calls itself,
 * so how deep a peer nests is not what decides whether this returns.
 */
export function describeUnknown(slot: Slot): { text: string; found: UnknownFindings } {
    const links = new Set<string>();
    const tags = new Set<string>();
    const hashes = new Set<string>();
    let text = '';

    const look = (value: string) => {
        for (const match of value.matchAll(ATTACHMENTS)) hashes.add(match[1].toLowerCase());
    };

    const left: Look[] = [];
    const push = (value: unknown, how: Omit<Look, 'value'> = {}) => left.push({ value, ...how });
    // Last in, first out, so a list goes on the stack backwards.
    const pushAll = (values: unknown[], how: Omit<Look, 'value'>) => {
        for (let i = values.length - 1; i >= 0; i--) push(values[i], how);
    };
    push(slot.value, { words: true });

    for (let next = left.pop(); next !== undefined; next = left.pop()) {
        const { value, words, inLine } = next;

        if (typeof value === 'string') {
            look(value);
            if (words) text += value;
        } else if (value instanceof Y.XmlText) {
            const delta = deltaOf(value);
            for (const op of delta) pushAll(Object.values(op.attributes ?? {}), {});
            for (const op of delta.reverse()) {
                push(op.insert, { words: typeof op.insert === 'string', inLine: true });
            }
        } else if (value instanceof Y.XmlElement) {
            const attrs = value.getAttributes() as Record<string, unknown>;
            pushAll(Object.values(attrs), {});

            if (value.nodeName === TAG_NODE_NAME && typeof attrs.name === 'string') {
                const name = normalizeTagName(attrs.name);
                if (name) {
                    tags.add(name);
                    text += `#${name}`;
                }
            } else if (value.nodeName === 'documentLink') {
                if (typeof attrs.targetId === 'string' && attrs.targetId) links.add(attrs.targetId);
                if (typeof attrs.title === 'string') text += attrs.title;
            } else if (value.nodeName === 'image') {
                const hash = attachmentHash(stringOr(attrs.src), stringOr(attrs.alt));
                if (hash) hashes.add(hash);
            }

            // What is in a line of writing runs on with it. Anything else is
            // on a line of its own.
            const alone = !inLine || value.nodeName === 'hardBreak';
            if (alone) {
                text += '\n';
                push('\n', { words: true });
            }
            const children = childValues(value);
            const line = children.some((child) => child instanceof Y.XmlText);
            pushAll(children, { words: true, inLine: line });
        } else if (value instanceof Y.Map) {
            pushAll([...value.values()], {});
        } else if (value instanceof Y.Text) {
            push(value.toString(), { words });
        } else if (value instanceof Y.Array) {
            pushAll(value.toArray(), {});
        } else if (value instanceof Y.XmlFragment) {
            pushAll(childValues(value), { words });
        } else if (isPlain(value)) {
            pushAll(Object.values(value), {});
        }
    }

    return {
        text: text
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ ?\n[ \n]*/g, '\n')
            .trim(),
        found: {
            linkTargets: [...links],
            tags: [...tags],
            attachmentHashes: [...hashes],
        },
    };
}

/**
 * A copy of a slot, to write it again somewhere else: where its placeholder
 * was dragged or pasted to, or the half of a quote it ended up in.
 *
 * Taken when it is read, since by the time it is needed the content it was
 * taken from is deleted. Held in a Y.Doc of its own, because a shared type
 * that is in no document cannot be read, and one can be put in only once.
 */
export class KeptCopy {
    private readonly held: () => unknown;

    constructor({ type, value }: Slot) {
        if (!type) {
            this.held = () => value;
            return;
        }
        const fragment = new Y.Doc().getXmlFragment('kept');
        insertValues(fragment, 0, [copyOf(type)]);
        this.held = () => fragment.get(0);
    }

    /** What to put in a list for it, new each time. */
    take(): unknown {
        return copyOf(this.held());
    }
}

/**
 * `value` again, belonging to no document yet. Not Yjs's `clone`, which takes
 * an embedded type as it is and so cannot copy a text that holds one.
 */
function copyOf(value: unknown): unknown {
    if (value instanceof Y.XmlElement) {
        const copy = new Y.XmlElement(value.nodeName);
        setAll(copy, value.getAttributes());
        insertValues(copy, 0, childValues(value).map(copyOf));
        return copy;
    }
    if (value instanceof Y.Text) {
        const copy = value instanceof Y.XmlText ? new Y.XmlText() : new Y.Text();
        copy.applyDelta(deltaOf(value).map((op) => ({ ...op, insert: copyOf(op.insert) })));
        setAll(copy as unknown as Y.XmlElement, value.getAttributes());
        return copy;
    }
    if (value instanceof Y.Map) {
        const copy: Y.Map<unknown> =
            value instanceof Y.XmlHook ? new Y.XmlHook(value.hookName) : new Y.Map();
        for (const [key, entry] of value.entries()) copy.set(key, copyOf(entry));
        return copy;
    }
    if (value instanceof Y.Array) {
        const copy = new Y.Array();
        copy.insert(0, value.toArray().map(copyOf));
        return copy;
    }
    if (value instanceof Y.XmlFragment) {
        const copy = new Y.XmlFragment();
        insertValues(copy, 0, childValues(value).map(copyOf));
        return copy;
    }
    // Yjs can hold these in a list and will not put them in one.
    if (value === undefined) return null;
    if (typeof value === 'bigint') return String(value);
    if (value instanceof Y.Doc) return new Y.Doc({ guid: value.guid, meta: value.meta });
    return value;
}

function setAll(element: Y.XmlElement, attrs: Record<string, unknown>): void {
    // Yjs types an attribute as text, and stores whatever it is given.
    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, copyOf(value) as string);
    }
}

export interface DeltaOp {
    insert: unknown;
    attributes?: Record<string, unknown>;
}

export function deltaOf(text: Y.Text): DeltaOp[] {
    return text.toDelta() as DeltaOp[];
}

function stringOr(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function isPlain(value: unknown): value is object {
    return (
        Array.isArray(value) ||
        (typeof value === 'object' &&
            value !== null &&
            Object.getPrototypeOf(value) === Object.prototype)
    );
}
