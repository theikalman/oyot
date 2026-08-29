import * as Y from 'yjs';
import { toasts } from '$lib/services/toast';
import type { Document } from '$lib/types';
import { appStore } from '$lib/stores/app';
import { documentRepository, broadcastLocalUpdate } from '$lib/sync';
import { bytesToBase64 } from '$lib/sync/protocol';

export interface SaveServiceOptions {
    debounceMs?: number;
    onSaving?: () => void;
    onSaved?: (doc: Document) => void;
}

export class EditorSaveService {
    private ydoc: Y.Doc | null = null;
    private currentDoc: Document | null = null;
    private saveTimeout: ReturnType<typeof setTimeout> | null = null;
    private debounceMs: number;
    private onSaving?: () => void;
    private onSaved?: (doc: Document) => void;
    private isDestroyed = false;

    constructor(options: SaveServiceOptions = {}) {
        this.debounceMs = options.debounceMs ?? 1000;
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
            this.performSave();
        }, this.debounceMs);
    }

    async forceSave(): Promise<Document | null> {
        if (this.isDestroyed || !this.currentDoc || !this.ydoc) {
            return null;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        return this.performSave();
    }

    private async performSave(): Promise<Document | null> {
        if (!this.ydoc || !this.currentDoc) return null;

        const docId = this.currentDoc.id;
        this.onSaving?.();

        try {
            const snapshot = Y.encodeStateAsUpdate(this.ydoc);

            if (snapshot.length === 0) {
                console.warn(`[EditorSaveService] [${docId}] No update to save, skipping`);
                return null;
            }

            console.log(`[EditorSaveService] [${docId}] Saving Yjs state (${snapshot.length} bytes)`);
            await documentRepository.saveLocalUpdate(docId, snapshot);
            console.log(`[EditorSaveService] [${docId}] save completed`);

            broadcastLocalUpdate(docId, bytesToBase64(snapshot));

            appStore.markDocumentHasContent(docId);
            return this.currentDoc;
        } catch (error) {
            console.error(`[EditorSaveService] [${docId}] Failed to save document:`, error);
            toasts.error('Failed to save document');
            return null;
        }
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