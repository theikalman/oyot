import * as Y from 'yjs';
import { toasts } from '$lib/services/toast';
import type { Document } from '$lib/types';
import { appStore } from '$lib/stores/app';
import { documentRepository, broadcastLocalUpdate } from '$lib/sync';
import { bytesToBase64, EMPTY_UPDATE_LEN } from '$lib/sync/protocol';

// Long enough to coalesce ordinary typing, short enough that an unexpected
// process death (Android killing a backgrounded app) loses very little. The
// flush-on-switch and flush-on-hide paths cover the predictable exits.
export const DEFAULT_DEBOUNCE_MS = 400;

export interface SaveServiceOptions {
    debounceMs?: number;
    onSaving?: () => void;
    onSaved?: (docId: string) => void;
}

// Persist a snapshot and tell paired devices about it.
//
// Everything is taken by value: this is called while the editor that produced
// `snapshot` is being torn down, so it must not read any mutable service state.
// Reading `this.ydoc` here instead is what made the old flush-on-switch write
// the incoming document's empty state under the outgoing document's id.
export async function persistSnapshot(docId: string, snapshot: Uint8Array): Promise<void> {
    if (snapshot.length <= EMPTY_UPDATE_LEN) return;
    try {
        await documentRepository.saveLocalUpdate(docId, snapshot);
        broadcastLocalUpdate(docId, bytesToBase64(snapshot));
        appStore.markDocumentHasContent(docId);
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

    constructor(options: SaveServiceOptions = {}) {
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.onSaving = options.onSaving;
        this.onSaved = options.onSaved;
    }

    setYDoc(ydoc: Y.Doc): void {
        this.ydoc = ydoc;
    }

    setDocument(doc: Document | null): void {
        this.currentDoc = doc;
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

        this.onSaving?.();
        return persistSnapshot(docId, snapshot)
            .then(() => {
                this.onSaved?.(docId);
            })
            .catch(() => {
                // persistSnapshot already reported it; swallow so a failed save
                // does not surface as an unhandled rejection on a teardown path.
                this.onSaved?.(docId);
            });
    }

    // True while an edit is sitting in the debounce window, i.e. there is
    // unwritten work that a teardown must flush.
    hasPendingWrite(): boolean {
        return this.saveTimeout !== null;
    }

    destroy(): void {
        this.isDestroyed = true;
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.ydoc = null;
        this.currentDoc = null;
    }
}

export function createSaveService(options: SaveServiceOptions = {}): EditorSaveService {
    return new EditorSaveService(options);
}
