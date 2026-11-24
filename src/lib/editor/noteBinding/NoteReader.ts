import * as Y from 'yjs';
import { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Mark, NodeType, Schema } from '@tiptap/pm/model';
import {
    isUnknown,
    isUnknownName,
    UNKNOWN_BLOCK,
    UNKNOWN_INLINE,
    UNKNOWN_MARK,
    writeFindings,
} from '$lib/tiptap/unknownContent';
import { childSlots, type SharedType, type Slot } from './slots';
import { deltaOf, describeUnknown } from './unknown';

/**
 * How many elements deep a note is shown. Past it, and well past anything
 * written by hand, content is kept and not shown, so that nothing that walks
 * the document runs out of stack.
 */
export const MAX_DEPTH = 200;

/** y-tiptap's: which node an element is shown as, or which nodes a text was last written from. */
export type Mapping = Map<SharedType, ProseMirrorNode | ProseMirrorNode[]>;

export interface ReaderOptions {
    mapping?: Mapping;
    /**
     * Whether this is the editor, reading the document it is bound to. Only
     * then is anything written: two texts that stand together are joined into
     * the first, when this session made the second. y-tiptap does that where
     * it reads, to fix characters doubling (y-prosemirror issue 160).
     */
    live?: boolean;
    /** What a slot is called, where it is not its own key. */
    refOf?: (key: string) => string;
    /** Told of everything that could not be shown, as it is found. */
    onUnknown?: (slot: Slot, placeholder: ProseMirrorNode) => void;
}

/**
 * Reads a note's Yjs content as the editor's document.
 *
 * In place of y-tiptap's reader, which answers whatever it cannot make, a
 * block from a newer build or a list a merge left empty, by deleting it from
 * the Y.Doc, and that syncs. Nothing is deleted here, and nothing throws:
 *
 * - an element, or anything else, that cannot be a node is a placeholder
 * - so is one that can be a node and not where it is, such as a list item on
 *   its own
 * - a node that is only missing something it has to have, such as a list with
 *   no items, is shown with it, and it is stored when that is next edited
 * - formatting by a name this build does not know is carried as a mark
 *
 * A placeholder stands for exactly one slot, so a parent has as many nodes as
 * it has slots, and what is written back is found by counting.
 */
export class NoteReader {
    readonly mapping: Mapping;
    /** Whether the note holds anything this build cannot show in full. */
    hasUnknown = false;
    /**
     * Whether y-tiptap's conversion between positions can be used. It takes a
     * note to be elements and texts, each shown as long as it is.
     */
    countable = true;
    /** What formatting this build does not know was stored as, by `markKey`. */
    readonly markValues = new Map<string, unknown>();

    private readonly live: boolean;
    private readonly refOf: (key: string) => string;
    private readonly onUnknown: (slot: Slot, placeholder: ProseMirrorNode) => void;

    // Attributes the schema has no name for, by the node they were left out of.
    private readonly undeclared = new WeakMap<ProseMirrorNode, Record<string, unknown>>();
    // Nodes that say less than what is stored for them.
    private readonly partial = new WeakSet<ProseMirrorNode>();
    // What `holdsUnknown` has worked out, until there is more to know.
    private held = new WeakMap<ProseMirrorNode, boolean>();

    constructor(
        private readonly schema: Schema,
        options: ReaderOptions = {},
    ) {
        this.mapping = options.mapping ?? new Map();
        this.live = options.live ?? false;
        this.refOf = options.refOf ?? ((key) => key);
        this.onUnknown = options.onUnknown ?? (() => {});
    }

    /** A note's blocks. None for an empty note. */
    blocks(fragment: Y.XmlFragment): ProseMirrorNode[] {
        const slots = childSlots(fragment);
        const parts = slots.map((slot) => this.child(slot, 1));
        // Never null: a placeholder fits wherever a block does.
        return this.fit(this.schema.topNodeType, slots, parts, false) ?? [];
    }

    /** Whether a node stands for, or is around, something it does not show in full. */
    holdsUnknown(node: ProseMirrorNode): boolean {
        let holds = this.held.get(node);
        if (holds === undefined) {
            holds =
                isUnknown(node) ||
                this.partial.has(node) ||
                node.marks.some((mark) => mark.type.name === UNKNOWN_MARK) ||
                node.content.content.some((child) => this.holdsUnknown(child));
            this.held.set(node, holds);
        }
        return holds;
    }

    /** The attributes stored with a node that the schema has no name for. */
    undeclaredOf(node: ProseMirrorNode): Record<string, unknown> {
        return this.undeclared.get(node) ?? {};
    }

    /** Note that `node` is shown without `attrs`, which are stored with it. */
    leaveOut(node: ProseMirrorNode, attrs: Record<string, unknown>): void {
        if (Object.keys(attrs).length === 0) return;
        this.undeclared.set(node, attrs);
        this.saysLess(node);
    }

    private saysLess(node: ProseMirrorNode): void {
        this.partial.add(node);
        this.held = new WeakMap();
        this.hasUnknown = true;
    }

    /** Whether a slot is shown as a placeholder. */
    isOpaque(slot: Slot): boolean {
        if (!slot.type) return true;
        const shown = this.mapping.get(slot.type);
        if (shown !== undefined) return !Array.isArray(shown) && isUnknown(shown);
        return !(slot.type instanceof Y.XmlElement || slot.type instanceof Y.XmlText);
    }

    ref(slot: Slot): string {
        return this.refOf(slot.key);
    }

    // --- elements -----------------------------------------------------------

    /** What a slot is shown as, words aside, or null when it cannot be. */
    private child(slot: Slot, depth: number): ProseMirrorNode[] | null {
        if (!(slot.type instanceof Y.XmlElement)) return null;
        const node = this.element(slot.type, depth);
        return node && [node];
    }

    private element(element: Y.XmlElement, depth: number): ProseMirrorNode | null {
        const mapped = this.mapping.get(element);
        if (mapped !== undefined && !Array.isArray(mapped)) return mapped;

        const name = element.nodeName;
        const type: NodeType | undefined = this.schema.nodes[name];
        if (!type || type === this.schema.topNodeType || type.isText) return null;
        // Never stored, so one that is was put there by something else.
        if (isUnknownName(name) || depth > MAX_DEPTH) return null;

        const slots = childSlots(element);
        let lost = false;
        const parts = slots.map((slot) => {
            // Words go in a line. Among blocks, even none at all are something
            // that is there, and cannot be shown.
            if (!(slot.type instanceof Y.XmlText) || !type.inlineContent) {
                return this.child(slot, depth + 1);
            }
            // Joined into the one before it, below.
            if (slot.type._item?.deleted) return [];
            if (this.live) this.joinNext(slot.type);
            const text = this.text(slot.type);
            if (text?.lost) lost = true;
            return text?.nodes ?? null;
        });

        const attrs = element.getAttributes() as Record<string, unknown>;
        const whole = parts.every((part) => part !== null) ? parts.flat() : null;
        let node = whole && this.make(name, attrs, whole);
        if (!node) {
            const fitted = this.fit(type, slots, parts, true);
            node = fitted && this.make(name, attrs, fitted);
            lost = true;
        }
        if (!node || (type.isInGroup('block') && holdsNothing(node))) return null;

        this.leaveOut(node, undeclaredAttrs(type, attrs));
        if (lost) this.saysLess(node);
        this.mapping.set(element, node);
        return node;
    }

    private make(
        name: string,
        attrs: Record<string, unknown>,
        content: ProseMirrorNode[],
    ): ProseMirrorNode | null {
        try {
            return this.schema.node(name, attrs, content);
        } catch {
            return null;
        }
    }

    /**
     * What `type` can hold of its slots: what fits as it is, a placeholder for
     * what does not, and, when `fill` is given, whatever it has to have
     * besides. Null when not even that makes it whole.
     */
    private fit(
        type: NodeType,
        slots: Slot[],
        parts: (ProseMirrorNode[] | null)[],
        fill: boolean,
    ): ProseMirrorNode[] | null {
        const out: ProseMirrorNode[] = [];
        let match = type.contentMatch;

        const take = (nodes: ProseMirrorNode[]): boolean => {
            if (!nodes.every((node) => type.allowsMarks(node.marks))) return false;
            const fragment = Fragment.from(nodes);
            const missing = fill ? match.fillBefore(fragment) : Fragment.empty;
            const after = missing && match.matchFragment(missing)?.matchFragment(fragment);
            if (!missing || !after) return false;
            if (missing.childCount > 0) this.countable = false;
            out.push(...missing.content, ...nodes);
            match = after;
            return true;
        };

        for (let i = 0; i < slots.length; i++) {
            const part = parts[i];
            if (part && take(part)) continue;
            if (!take([this.placeholder(slots[i], type.inlineContent)])) return null;
        }
        if (fill) {
            const missing = match.fillBefore(Fragment.empty, true);
            if (!missing) return null;
            if (missing.childCount > 0) this.countable = false;
            out.push(...missing.content);
        }
        return out;
    }

    private placeholder(slot: Slot, inline: boolean): ProseMirrorNode {
        const { text, found } = describeUnknown(slot);
        const node = this.schema.nodes[inline ? UNKNOWN_INLINE : UNKNOWN_BLOCK].create({
            ref: this.ref(slot),
            text,
            found: writeFindings(found),
        });
        if (slot.type) this.mapping.set(slot.type, node);
        if (!(slot.type instanceof Y.XmlElement)) this.countable = false;
        this.hasUnknown = true;
        this.onUnknown(slot, node);
        return node;
    }

    // --- texts ----------------------------------------------------------------

    /** A text's words and formatting, or null when it holds more than words. */
    private text(text: Y.XmlText): { nodes: ProseMirrorNode[]; lost: boolean } | null {
        try {
            let lost = false;
            const nodes = deltaOf(text).map(({ insert, attributes = {} }) => {
                if (typeof insert !== 'string') throw new Error('not words');
                const marks = Object.entries(attributes).map(([key, value]) => {
                    const mark = this.mark(key, value);
                    if (hasUndeclared(mark, value)) lost = true;
                    return mark;
                });
                return this.schema.text(insert, marks);
            });
            return { nodes, lost };
        } catch {
            return null;
        }
    }

    private mark(key: string, value: unknown): Mark {
        const name = this.markName(key);
        if (name !== null) {
            try {
                return this.schema.mark(name, value as Record<string, unknown>);
            } catch {
                // Carried as it is, like a name that is not known at all.
            }
        }
        const json = JSON.stringify(value);
        // Nothing JSON can say, so nothing the mark can hold.
        if (json === undefined) throw new Error('not formatting');
        this.hasUnknown = true;
        this.markValues.set(markKey(key, json), value);
        return this.schema.marks[UNKNOWN_MARK].create({ name: key, value: json });
    }

    /**
     * The mark stored under `key`, or null for one this build does not know.
     * y-tiptap adds a hash to the name of a mark that can be on a word twice.
     */
    private markName(key: string): string | null {
        if (key === UNKNOWN_MARK) return null;
        if (this.schema.marks[key]) return key;
        const name = /^(.*)--[a-zA-Z0-9+/=]{8}$/.exec(key)?.[1];
        const type = name === undefined ? undefined : this.schema.marks[name];
        return type && name !== UNKNOWN_MARK && !type.excludes(type) ? name! : null;
    }

    private joinNext(text: Y.XmlText): void {
        const content = text._item?.right?.content;
        const next = content instanceof Y.ContentType ? content.type : null;
        if (!(next instanceof Y.Text) || !next._item || next._item.deleted) return;
        if (next._item.id.client !== next.doc?.clientID) return;
        // Only words. Anything else is a placeholder, and stays where it is.
        const delta = deltaOf(next);
        if (![...delta, ...deltaOf(text)].every((op) => typeof op.insert === 'string')) return;
        text.applyDelta([{ retain: text.length }, ...delta]);
        next.doc.transact((transaction) => next._item!.delete(transaction));
    }
}

/**
 * Whether a node has no line and nothing else in it: a table with no cells,
 * which the table extension answers by deleting it.
 */
function holdsNothing(node: ProseMirrorNode): boolean {
    return !node.isLeaf && !node.isTextblock && node.content.content.every(holdsNothing);
}

/** What a mark's stored value is kept under. */
export function markKey(name: string, json: string): string {
    return `${name}\n${json}`;
}

/** The attributes `type` has no name for. */
export function undeclaredAttrs(
    type: NodeType,
    attrs: Record<string, unknown>,
): Record<string, unknown> {
    const declared = type.spec.attrs ?? {};
    return Object.fromEntries(Object.entries(attrs).filter(([key]) => !(key in declared)));
}

function hasUndeclared(mark: Mark, value: unknown): boolean {
    if (mark.type.name === UNKNOWN_MARK || typeof value !== 'object' || value === null) {
        return false;
    }
    const declared = mark.type.spec.attrs ?? {};
    return Object.keys(value).some((key) => !(key in declared));
}
