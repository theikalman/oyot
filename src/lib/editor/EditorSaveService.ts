import { invoke } from '@tauri-apps/api/core';
import { LoroApp } from '$lib/loro/loroApp';
import { toasts } from '$lib/services/toast';
import type { Document, DocumentSummary } from '$lib/types';
import { appStore } from '$lib/stores/app';

export interface SaveServiceOptions {
    debounceMs?: number;
    onSaving?: () => void;
    onSaved?: (doc: Document) => void;
}

export class EditorSaveService {
    private loroApp: LoroApp | null = null;
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

    setLoroApp(app: LoroApp): void {
        this.loroApp = app;
    }

    setDocument(doc: Document | null): void {
        this.currentDoc = doc;
    }

    triggerSave(): void {
        if (this.isDestroyed || !this.currentDoc || !this.loroApp) return;

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.performSave();
        }, this.debounceMs);
    }

    async forceSave(): Promise<Document | null> {
        if (this.isDestroyed || !this.currentDoc || !this.loroApp) {
            return null;
        }

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }

        return this.performSave();
    }

    private async performSave(): Promise<Document | null> {
        if (!this.loroApp || !this.currentDoc) return null;

        this.onSaving?.();

        try {
            const update = this.loroApp.getUpdate();
            console.log('[EditorSaveService] getUpdate() returned', update.length, 'bytes');
            const crdtState = Array.from(update);

            if (update.length === 0) {
                console.warn('[EditorSaveService] No update to save, skipping');
                return null;
            }

            const updatedDoc: Document = await invoke('save_crdt_update', {
                docId: this.currentDoc.id,
                update: crdtState
            });

            const metadata = this.loroApp.getMetadata();
            const summary: DocumentSummary = {
                id: updatedDoc.id,
                doc_type: updatedDoc.doc_type,
                title: metadata.title || updatedDoc.title,
                todo_count: metadata.todo_count,
                completed_todo_count: metadata.completed_todo_count,
                created_at: updatedDoc.created_at,
                updated_at: updatedDoc.updated_at
            };

            appStore.updateDocumentInList(summary);
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
        this.loroApp = null;
        this.currentDoc = null;
    }
}

export function createSaveService(options: SaveServiceOptions = {}): EditorSaveService {
    return new EditorSaveService(options);
}