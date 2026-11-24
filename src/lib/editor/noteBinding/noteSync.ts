import * as Y from 'yjs';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode, Mark, Schema } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Selection, Transaction } from '@tiptap/pm/state';
import {
    getRelativeSelection,
    isMisresolvedTextPosition,
    ProsemirrorBinding,
    relativePositionToAbsolutePosition,
    updateYFragment,
    ySyncPluginKey,
    yUndoPluginKey,
} from '@tiptap/y-tiptap';
import {
    isUnknown,
    UNKNOWN_BLOCK,
    UNKNOWN_MARK,
    unknownLine,
    unknownText,
} from '$lib/tiptap/unknownContent';
import { markKey, NoteReader } from './NoteReader';
import { NoteWriter } from './NoteWriter';
import { childSlots, type Slot } from './slots';
import { KeptCopy } from './unknown';

/** A selection in the Yjs content, or where it was when that cannot be said. */
type KeptSelection =
    ReturnType<typeof getRelativeSelection> | { type: 'place'; anchor: number; head: number };

/**
 * y-tiptap's binding of an editor to a note, with a reader that never deletes
 * and a writer that keeps what is unknown where it is.
 */
class NoteBinding extends ProsemirrorBinding {
    readonly reader: NoteReader;
    private readonly schema: Schema;
    // Copies of unknown content, by what its placeholder calls it.
    private readonly kept = new Map<string, { placeholder: ProseMirrorNode; copy: KeptCopy }>();
    // Content that was written again is a new item in the Y.Doc, and its
    // placeholder still calls it what it was.
    private readonly refs = new Map<string, string>();
    private pasted = 0;

    constructor(fragment: Y.XmlFragment, schema: Schema) {
        super(fragment);
        this.schema = schema;
        this.reader = new NoteReader(schema, {
            mapping: this.mapping as NoteReader['mapping'],
            live: true,
            refOf: (key) => this.refs.get(key) ?? key,
            onUnknown: (slot, placeholder) => this.keep(slot, placeholder),
        });
        this.beforeAllTransactions = () => {
            if (this.beforeTransactionSelection === null && this.prosemirrorView !== null) {
                this.beforeTransactionSelection = this.selectionOf(this.prosemirrorView.state);
            }
        };
    }

    override _forceRerender(): void {
        this.mapping.clear();
        this.mux(() => {
            const { state } = this.prosemirrorView;
            const selection: Selection | null =
                this.beforeTransactionSelection !== null ? null : state.selection;
            const tr = this.rendered();
            if (selection) {
                const place = (pos: number) => Math.min(Math.max(pos, 0), tr.doc.content.size);
                tr.setSelection(
                    TextSelection.create(tr.doc, place(selection.anchor), place(selection.head)),
                );
            }
            tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, binding: this });
            this.prosemirrorView.dispatch(tr);
        });
    }

    override _typeChanged(_events: Y.YEvent<never>[], transaction: Y.Transaction): void {
        if (this.prosemirrorView === null) return;
        this.mux(() => {
            Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
                if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) {
                    this.mapping.delete(struct.content.type);
                }
            });
            for (const type of transaction.changed.keys()) this.mapping.delete(type);
            for (const type of transaction.changedParentTypes.keys()) this.mapping.delete(type);
            if (this.showsUnstored()) this.mapping.clear();

            const tr = this.rendered();
            this.restoreSelection(tr);
            tr.setMeta(ySyncPluginKey, {
                isChangeOrigin: true,
                isUndoRedoOperation: transaction.origin instanceof Y.UndoManager,
            });
            if (this.beforeTransactionSelection !== null && this._isLocalCursorInView()) {
                tr.scrollIntoView();
            }
            this.prosemirrorView.dispatch(tr);
        });
    }

    override _prosemirrorChanged(doc: ProseMirrorNode): void {
        this.doc.transact(() => {
            if (this.reader.hasUnknown) this.write(doc);
            else updateYFragment(this.doc, this.type, doc, this);
            this.beforeTransactionSelection = this.selectionOf(this.prosemirrorView.state);
        }, ySyncPluginKey);
    }

    // --- unknown content ------------------------------------------------------

    private write(doc: ProseMirrorNode): void {
        const writer = new NoteWriter(this.doc, this.reader, ySyncPluginKey, ({ attrs }) => {
            const kept = this.kept.get(attrs.ref);
            return kept ? [kept.copy.take()] : [];
        });
        writer.write(this.type, doc);
        if (writer.rewrote) this.nameRewritten(doc);
    }

    private keep(slot: Slot, placeholder: ProseMirrorNode): void {
        try {
            const copy = new KeptCopy(slot);
            this.kept.set(placeholder.attrs.ref, { placeholder, copy });
        } catch {
            // Nested past what can be copied. It stays where it is stored, and
            // is only lost by deleting or moving it.
        }
    }

    /** Have what was written again go by what its placeholder calls it. */
    private nameRewritten(doc: ProseMirrorNode): void {
        const slots: Slot[] = [];
        const collect = (parent: Y.XmlFragment) => {
            for (const slot of childSlots(parent)) {
                if (this.reader.isOpaque(slot)) slots.push(slot);
                else if (slot.type instanceof Y.XmlElement) collect(slot.type);
            }
        };
        collect(this.type);

        const stored = new Set(slots.map((slot) => this.reader.ref(slot)));
        const refs: string[] = [];
        doc.descendants((node) => {
            if (!isUnknown(node)) return;
            const { ref } = node.attrs;
            if (this.kept.has(ref) || stored.has(ref)) refs.push(ref);
        });
        // The two are the same content, in the same order, by now.
        slots.slice(0, refs.length).forEach((slot, i) => this.refs.set(slot.key, refs[i]));
    }

    /**
     * What was pasted or dropped, with each placeholder standing for a copy of
     * its own. One that stands for nothing in this note, from another note or
     * from a page, is only the words it says.
     */
    pastedSlice(slice: Slice): Slice {
        const content = this.pastedContent(slice.content);
        return content === slice.content
            ? slice
            : new Slice(content, slice.openStart, slice.openEnd);
    }

    private pastedContent(content: Fragment): Fragment {
        let changed = false;
        const nodes: ProseMirrorNode[] = [];
        content.forEach((node) => {
            const pasted = this.pastedNode(node);
            if (pasted.length !== 1 || pasted[0] !== node) changed = true;
            nodes.push(...pasted);
        });
        return changed ? Fragment.from(nodes) : content;
    }

    private pastedNode(node: ProseMirrorNode): ProseMirrorNode[] {
        const marks = node.marks.filter((mark) => this.knowsMark(mark));
        if (!isUnknown(node)) {
            const content = this.pastedContent(node.content);
            if (content === node.content && marks.length === node.marks.length) return [node];
            return [node.isText ? node.mark(marks) : node.copy(content).mark(marks)];
        }

        const kept = this.kept.get(node.attrs.ref);
        if (kept) {
            const ref = `pasted:${this.pasted++}`;
            const attrs = { ...kept.placeholder.attrs, ref };
            this.kept.set(ref, { ...kept, placeholder: kept.placeholder.type.create(attrs) });
            return [node.type.create(attrs, null, marks)];
        }

        if (node.type.name !== UNKNOWN_BLOCK) {
            const line = unknownLine(node);
            return line ? [this.schema.text(line, marks)] : [];
        }
        return unknownText(node)
            .split('\n')
            .map((line) => this.schema.node('paragraph', null, line ? this.schema.text(line) : []));
    }

    private knowsMark(mark: Mark): boolean {
        if (mark.type.name !== UNKNOWN_MARK) return true;
        return this.reader.markValues.has(markKey(mark.attrs.name, mark.attrs.value));
    }

    // --- rendering ------------------------------------------------------------

    private rendered(): Transaction {
        const blocks = this.reader.blocks(this.type);
        const tr: Transaction = this._tr;
        return tr.replace(0, tr.doc.content.size, new Slice(Fragment.from(blocks), 0, 0));
    }

    /**
     * Whether formatting is shown on what is not words, which Yjs does not
     * store. y-tiptap since 3.0.7 reads a whole note again at each change made
     * elsewhere, so it stops showing it then. Reading all of a long note is
     * slow, so it is done only for this. Otherwise the content is the same, and
     * once in a while is stored in other items.
     */
    private showsUnstored(): boolean {
        let found = false;
        this.prosemirrorView.state.doc.descendants((node: ProseMirrorNode) => {
            found ||= !node.isText && node.marks.length > 0;
            return !found;
        });
        return found;
    }

    // --- the selection -------------------------------------------------------

    /**
     * Where the selection is in the Yjs content. y-tiptap's reckoning takes a
     * note to be elements and texts and nothing else, and throws or miscounts
     * where it is not, so the selection is then kept by its place.
     */
    selectionOf(state: EditorState): ProsemirrorBinding['beforeTransactionSelection'] {
        let kept: KeptSelection | null = null;
        if (this.reader.countable) {
            try {
                kept = getRelativeSelection(this, state);
            } catch {
                // Kept by its place.
            }
        }
        const { anchor, head } = state.selection;
        kept ??= { type: 'place', anchor, head };
        return kept as ProsemirrorBinding['beforeTransactionSelection'];
    }

    /**
     * Put the selection back where Yjs says it is. y-tiptap has since 3.0.7
     * looked for a block with the same words when they differ, which moves the
     * caret to another line when a peer types in one of two that were alike.
     */
    private restoreSelection(tr: Transaction): void {
        const kept = this.beforeTransactionSelection as KeptSelection | null;
        if (kept === null || kept.anchor === null || kept.head === null) return;
        if (kept.type === 'all') {
            tr.setSelection(new AllSelection(tr.doc));
            return;
        }
        const at = (place: unknown): number | null => {
            let pos: number | null;
            if (kept.type === 'place') pos = place as number;
            else {
                pos = relativePositionToAbsolutePosition(this.doc, this.type, place, this.mapping);
                // Null also where the words up to it, from the start of the
                // note, are gone, which leaves it at the start.
                const relative = place as Y.RelativePosition;
                if (pos === null && isMisresolvedTextPosition(this.doc, relative, 1)) pos = 1;
            }
            return pos === null ? null : Math.min(Math.max(pos, 0), tr.doc.content.size);
        };

        const anchor = at(kept.anchor);
        if (anchor === null) return;
        if (kept.type === 'node') {
            const $anchor = tr.doc.resolve(anchor);
            tr.setSelection(
                $anchor.nodeAfter
                    ? NodeSelection.create(tr.doc, anchor)
                    : TextSelection.near($anchor),
            );
            return;
        }
        const head = at(kept.head);
        if (head === null) return;
        tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
    }
}

interface SyncState {
    binding: NoteBinding;
    addToHistory: boolean;
    isChangeOrigin: boolean;
    isUndoRedoOperation: boolean;
}

/**
 * y-tiptap's sync plugin, under its own key, for the binding above. The
 * collaboration extension, the undo plugin and Tiptap itself find it by that
 * key and read the same state from it. Snapshots are left out: Oyot has none.
 */
export function noteSyncPlugin(fragment: Y.XmlFragment, schema: Schema): Plugin {
    const binding = new NoteBinding(fragment, schema);
    let changed = false;

    return new Plugin<SyncState>({
        key: ySyncPluginKey,
        state: {
            init: () => ({
                type: fragment,
                doc: fragment.doc,
                binding,
                snapshot: null,
                prevSnapshot: null,
                isChangeOrigin: false,
                isUndoRedoOperation: false,
                addToHistory: true,
            }),
            apply: (tr, state) => {
                const change = tr.getMeta(ySyncPluginKey);
                return {
                    ...state,
                    ...change,
                    addToHistory: tr.getMeta('addToHistory') !== false,
                    isChangeOrigin: !!change?.isChangeOrigin,
                    isUndoRedoOperation: !!change?.isChangeOrigin && !!change.isUndoRedoOperation,
                };
            },
        },
        props: {
            transformPasted: (slice) => binding.pastedSlice(slice),
        },
        view: (view) => {
            binding.initView(view);
            binding._forceRerender();
            return {
                update: (_view, before) => {
                    const state: SyncState = ySyncPluginKey.getState(view.state);
                    const { doc } = view.state;
                    // An empty note the editor has put a line in is not a change.
                    const empty = doc.type.createAndFill()!;
                    changed ||= doc.content.findDiffStart(empty.content) !== null;
                    if (!changed) return;
                    // A note holding something unknown is written when it is
                    // edited and not before: the empty line the editor adds
                    // after a last block that is not one is an edit to no one.
                    if (binding.reader.hasUnknown && before.doc === doc) return;

                    if (!state.addToHistory && !state.isChangeOrigin) {
                        yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
                    }
                    binding.mux(() => {
                        binding.doc.transact((transaction) => {
                            transaction.meta.set('addToHistory', state.addToHistory);
                            binding._prosemirrorChanged(doc);
                        }, ySyncPluginKey);
                    });
                },
                destroy: () => binding.destroy(),
            };
        },
    });
}

/**
 * The undo plugin, with the binding's own reckoning of where the selection is:
 * it asks at every step, and y-tiptap's throws on a note it cannot count.
 */
export function withNoteSelection(undo: Plugin): Plugin {
    const { state } = undo.spec;
    if (!state) return undo;
    undo.spec.state = {
        ...state,
        apply: (_tr, { undoManager }, before, after) => ({
            undoManager,
            prevSel: (ySyncPluginKey.getState(after) as SyncState).binding.selectionOf(before),
            hasUndoOps: undoManager.undoStack.length > 0,
            hasRedoOps: undoManager.redoStack.length > 0,
        }),
    };
    return undo;
}
