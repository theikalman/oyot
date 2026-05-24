import * as Y from 'yjs';
import { toasts } from '$lib/services/toast';
import { commitLocalUpdate, broadcastP2PUpdate } from '$lib/services/documents';
import type { Document } from '$lib/types';
import { appStore } from '$lib/stores/app';

/** Origin tag applied to remote updates so the 'update' handler can skip them. */
export const REMOTE_ORIGIN = 'remote-network-sync-origin';

export interface SaveServiceOptions {
    onSaving?: () => void;
    onSaved?: () => void;
}

export class EditorSaveService {
    private ydoc: Y.Doc | null = null;
    private currentDoc: Document | null = null;
    private onSaving?: () => void;
    private onSaved?: () => void;
    private isDestroyed = false;
    private updateHandler: ((update: Uint8Array, origin: unknown, doc: Y.Doc, tr: Y.Transaction) => void) | null = null;

    constructor(options: SaveServiceOptions = {}) {
        this.onSaving = options.onSaving;
        this.onSaved = options.onSaved;
    }

    setYjsDoc(ydoc: Y.Doc): void {
        // Remove listener from the previous doc if any
        if (this.ydoc && this.updateHandler) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.ydoc as any).off('update', this.updateHandler);
        }

        this.ydoc = ydoc;
        this.updateHandler = (update: Uint8Array, origin: unknown) => {
            if (this.isDestroyed) return;
            // Skip updates that originated from a remote peer to avoid
            // re-persisting and re-broadcasting received data.
            if (origin === REMOTE_ORIGIN) return;
            this.handleYjsUpdate(update);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.ydoc as any).on('update', this.updateHandler);
    }

    setDocument(doc: Document | null): void {
        this.currentDoc = doc;
    }

    private async handleYjsUpdate(update: Uint8Array): Promise<void> {
        if (!this.currentDoc) return;

        this.onSaving?.();

        const docId = this.currentDoc.id;
        const title = this.currentDoc.title;

        try {
            await Promise.all([
                commitLocalUpdate(docId, update, title),
                broadcastP2PUpdate(docId, update),
            ]);

            appStore.updateDocumentInList({
                id: this.currentDoc.id,
                doc_type: this.currentDoc.doc_type,
                title: this.currentDoc.title,
                created_at: this.currentDoc.created_at,
                updated_at: Date.now(),
            });

            this.onSaved?.();
        } catch (error) {
            console.error('[EditorSaveService] Failed to save update:', error);
            toasts.error('Failed to save document');
        }
    }

    destroy(): void {
        this.isDestroyed = true;
        if (this.ydoc && this.updateHandler) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this.ydoc as any).off('update', this.updateHandler);
        }
        this.ydoc = null;
        this.currentDoc = null;
        this.updateHandler = null;
    }
}

export function createSaveService(options: SaveServiceOptions = {}): EditorSaveService {
    return new EditorSaveService(options);
}
