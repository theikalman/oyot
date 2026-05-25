import { invoke } from '@tauri-apps/api/core';
import * as Y from 'yjs';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';

export interface YjsSyncServiceOptions {
    ydoc: Y.Doc;
    docId: string;
    signalingUrl?: string;
    user?: { name: string; color: string };
}

export class YjsSyncService {
    private ydoc: Y.Doc;
    private docId: string;
    private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
    private unlistenFn: UnlistenFn | null = null;
    private isDestroyed = false;

    constructor(options: YjsSyncServiceOptions) {
        this.ydoc = options.ydoc;
        this.docId = options.docId;
    }

    start(): void {
        this.updateHandler = (update: Uint8Array, _origin: unknown) => {
            this.broadcastUpdate(update);
        };

        this.ydoc.on('update', this.updateHandler);

        listen<{ doc_id: string; from?: string }>('sync-received', (event) => {
            if (event.payload.doc_id === this.docId) {
                this.reloadDocument();
            }
        }).then((unlisten) => {
            this.unlistenFn = unlisten;
        });
    }

    private async broadcastUpdate(update: Uint8Array): Promise<void> {
        if (this.isDestroyed) return;

        try {
            await invoke('save_yjs_update', {
                docId: this.docId,
                update: Array.from(update),
                mergedState: Array.from(Y.encodeStateAsUpdate(this.ydoc)),
            });
        } catch (error) {
            console.error('[YjsSyncService] Failed to broadcast update:', error);
        }
    }

    private async reloadDocument(): Promise<void> {
        try {
            const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', {
                docId: this.docId,
            });
            if (stateResult.state && stateResult.state.length > 0) {
                const state = new Uint8Array(stateResult.state);
                Y.applyUpdate(this.ydoc, state);
            }
        } catch (error) {
            console.error('[YjsSyncService] Failed to reload document:', error);
        }
    }

    async triggerFullSync(): Promise<void> {
        try {
            await invoke('trigger_sync');
        } catch (error) {
            console.error('[YjsSyncService] Failed to trigger sync:', error);
        }
    }

    setYDoc(ydoc: Y.Doc): void {
        if (this.updateHandler) {
            this.ydoc.off('update', this.updateHandler);
        }
        this.ydoc = ydoc;
        this.start();
    }

    setDocId(docId: string): void {
        this.docId = docId;
    }

    destroy(): void {
        this.isDestroyed = true;
        if (this.updateHandler) {
            this.ydoc.off('update', this.updateHandler);
            this.updateHandler = null;
        }
        if (this.unlistenFn) {
            this.unlistenFn();
            this.unlistenFn = null;
        }
    }
}

export function createYjsSyncService(options: YjsSyncServiceOptions): YjsSyncService {
    return new YjsSyncService(options);
}