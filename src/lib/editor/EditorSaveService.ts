import * as Y from 'yjs';
import { toasts } from '$lib/services/toast';
import type { Document } from '$lib/types';
import { appStore } from '$lib/stores/app';
import { documentRepository } from '$lib/sync';
import { EMPTY_UPDATE_LEN } from '$lib/sync/protocol';
import type { DocumentIndex } from './documentIndex';

// Long enough to coalesce ordinary typing, short enough that an unexpected
// process death (Android killing a backgrounded app) loses very little. The
// flush-on-switch and flush-on-hide paths cover the predictable exits.
export const DEFAULT_DEBOUNCE_MS = 400;

export interface SaveServiceOptions {
    debounceMs?: number;
    onSaving?: () => void;
    onSaved?: (docId: string) => void;
}

// Persist a snapshot. Rust sends connected devices whatever it adds to the
// store, and nothing when it adds nothing, so a save the user did not prompt
// sends no one anything (ADR 0031, decision 4).
//
// Everything is taken by value: this is called while the editor that produced
// `snapshot` is being torn down, so it must not read any mutable service state.
// Reading `this.ydoc` here instead is what made the old flush-on-switch write
// the incoming document's empty state under the outgoing document's id.
export async function persistSnapshot(
    docId: string,
    snapshot: Uint8Array,
    index?: DocumentIndex,
): Promise<void> {
    if (snapshot.length <= EMPTY_UPDATE_LEN) return;
    try {
        await documentRepository.saveLocalUpdate(docId, snapshot, index);
        appStore.markDocumentHasContent(docId);
        if (index) {
            appStore.setDocumentCounts(docId, index.todoCount, index.completedTodoCount);
        }
    } catch (error) {
        console.error(`[EditorSaveService] [${docId}] Failed to save document:`, error);
        toasts.error('Failed to save document');
        throw error;
    }
}

export class EditorSaveService {
    private ydoc: Y.Doc | null = null;
    private currentDoc: Document | null = null;
    private saveTimeout: ReturnType<typeof setTimeout> | null = null;
    private debounceMs: number;
    private onSaving?: () => void;
    private onSaved?: (docId: string) => void;
    private isDestroyed = false;
    // Set when a write fails, so the next trigger writes again instead of
    // treating the document as saved. A failed save used to be reported and
    // then forgotten: if nothing else was typed, the edit was lost on the
    // next document switch, which destroys the Y.Doc it lived in.
    private dirty = false;
    // Supplied by the editor, because only it can read the rendered document.
    private readIndex: (() => DocumentIndex | null) | null = null;

    constructor(options: SaveServiceOptions = {}) {
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.onSaving = options.onSaving;
        this.onSaved = options.onSaved;
    }

    setYDoc(ydoc: Y.Doc): void {
        this.ydoc = ydoc;
    }

    setIndexReader(read: () => DocumentIndex | null): void {
        this.readIndex = read;
    }

    setDocument(doc: Document | null): void {
        this.currentDoc = doc;
        // An edit belongs to the document that produced it, and a switch has
        // already flushed it.
        this.dirty = false;
    }

    // A local Yjs update, straight from the document's update event: the
    // document has an edit to write, so schedule the write.
    recordUpdate(): void {
        if (this.isDestroyed) return;
        this.dirty = true;
        this.triggerSave();
    }

    triggerSave(): void {
        if (this.isDestroyed || !this.currentDoc || !this.ydoc) return;

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            void this.flushNow();
        }, this.debounceMs);
    }

    // Cancel any pending debounce and write immediately.
    //
    // The snapshot and the document id are read synchronously, before the
    // returned promise is awaited, so this is safe to call on a teardown path
    // where the ydoc is about to be replaced. Returns null when there is
    // nothing to write.
    flushNow(): Promise<void> | null {
        if (this.isDestroyed || !this.ydoc || !this.currentDoc) return null;

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        const docId = this.currentDoc.id;
        const snapshot = Y.encodeStateAsUpdate(this.ydoc);
        if (snapshot.length <= EMPTY_UPDATE_LEN) return null;

        // Read synchronously, before the returned promise is awaited: the
        // caller may be tearing this editor down.
        const index = this.readIndex?.() ?? undefined;

        this.onSaving?.();
        return persistSnapshot(docId, snapshot, index)
            .then(() => {
                this.dirty = false;
                this.onSaved?.(docId);
            })
            .catch(() => {
                // persistSnapshot already reported it to the user; swallow so
                // a failed save does not surface as an unhandled rejection on
                // a teardown path. Remember it, though: the content is still
                // only in memory, and the next save sends it with its own.
                this.dirty = true;
                this.onSaved?.(docId);
            });
    }

    // True when there is unwritten work a teardown must flush: an edit inside
    // the debounce window, or a write that failed and has not been retried.
    hasPendingWrite(): boolean {
        return this.saveTimeout !== null || this.dirty;
    }

    destroy(): void {
        this.isDestroyed = true;
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.ydoc = null;
        this.currentDoc = null;
        this.dirty = false;
    }
}

export function createSaveService(options: SaveServiceOptions = {}): EditorSaveService {
    return new EditorSaveService(options);
}
