import { invoke } from '@tauri-apps/api/core';
import { exportLoroDocSnapshot } from '$lib/collab/LoroEditorExtension';
import { toasts } from '$lib/services/toast';
import type { Document } from '$lib/types';
import { appStore } from '$lib/stores/app';

export interface SaveServiceOptions {
    debounceMs?: number;
    onSaving?: () => void;
    onSaved?: (doc: Document) => void;
}

export class EditorSaveService {
    private loroDoc: any = null;
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

    setLoroDoc(doc: any): void {
        this.loroDoc = doc;
    }

    setDocument(doc: Document | null): void {
        this.currentDoc = doc;
    }

    triggerSave(): void {
        if (this.isDestroyed || !this.currentDoc || !this.loroDoc) return;

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.performSave();
        }, this.debounceMs);
    }

    async forceSave(): Promise<Document | null> {
        if (this.isDestroyed || !this.currentDoc || !this.loroDoc) {
            return null;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        return this.performSave();
    }

    private async performSave(): Promise<Document | null> {
        if (!this.loroDoc || !this.currentDoc) return null;

        this.onSaving?.();

        try {
            const snapshot = exportLoroDocSnapshot(this.loroDoc);
            const crdtState = Array.from(snapshot);

            if (snapshot.length === 0) {
                console.warn('[EditorSaveService] No snapshot to save, skipping');
                return null;
            }

            const updatedDoc: Document = await invoke('save_crdt_update', {
                docId: this.currentDoc.id,
                update: crdtState
            });

            appStore.updateDocumentInList({
                id: updatedDoc.id,
                doc_type: updatedDoc.doc_type,
                title: updatedDoc.title,
                todo_count: 0,
                completed_todo_count: 0,
                created_at: updatedDoc.created_at,
                updated_at: updatedDoc.updated_at
            });
            this.onSaved?.(updatedDoc);

            return updatedDoc;
        } catch (error) {
            console.error('Failed to save document:', error);
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
        this.loroDoc = null;
        this.currentDoc = null;
    }
}

export function createSaveService(options: SaveServiceOptions = {}): EditorSaveService {
    return new EditorSaveService(options);
}
