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
        console.log(`[YjsSyncService] start() for docId=${this.docId}`);
        this.updateHandler = (update: Uint8Array, _origin: unknown) => {
            console.log(`[YjsSyncService] [${this.docId}] Local ydoc 'update' event fired (${update.byteLength} bytes, origin=${String(_origin)})`);
            this.broadcastUpdate(update);
        };

        this.ydoc.on('update', this.updateHandler);

        listen<{ doc_id: string; from?: string }>('sync-received', (event) => {
            console.log(`[YjsSyncService] event: sync-received doc_id=${event.payload.doc_id} from=${event.payload.from ?? '(local)'} (watching docId=${this.docId})`);
            if (event.payload.doc_id === this.docId) {
                this.reloadDocument();
            } else {
                console.log(`[YjsSyncService] Ignoring sync-received for ${event.payload.doc_id}, not the active document`);
            }
        }).then((unlisten) => {
            this.unlistenFn = unlisten;
        });
    }

    private async broadcastUpdate(update: Uint8Array): Promise<void> {
        if (this.isDestroyed) {
            console.log(`[YjsSyncService] [${this.docId}] broadcastUpdate() skipped, service destroyed`);
            return;
        }

        try {
            console.log(`[YjsSyncService] [${this.docId}] Saving Yjs update to backend (update=${update.byteLength} bytes)`);
            await invoke('save_yjs_update', {
                docId: this.docId,
                update: Array.from(update),
                mergedState: Array.from(Y.encodeStateAsUpdate(this.ydoc)),
            });
            console.log(`[YjsSyncService] [${this.docId}] save_yjs_update completed`);
        } catch (error) {
            console.error(`[YjsSyncService] [${this.docId}] Failed to broadcast update:`, error);
        }
    }

    private async reloadDocument(): Promise<void> {
        try {
            console.log(`[YjsSyncService] [${this.docId}] reloadDocument() fetching yjs state from backend`);
            const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', {
                docId: this.docId,
            });
            console.log(`[YjsSyncService] [${this.docId}] Fetched state: ${stateResult.state?.length ?? 0} bytes`);
            if (stateResult.state && stateResult.state.length > 0) {
                const state = new Uint8Array(stateResult.state);
                Y.applyUpdate(this.ydoc, state);
                console.log(`[YjsSyncService] [${this.docId}] Applied fetched state to local ydoc`);
            }
        } catch (error) {
            console.error(`[YjsSyncService] [${this.docId}] Failed to reload document:`, error);
        }
    }

    async triggerFullSync(): Promise<void> {
        try {
            console.log(`[YjsSyncService] [${this.docId}] triggerFullSync()`);
            await invoke('trigger_sync');
        } catch (error) {
            console.error(`[YjsSyncService] [${this.docId}] Failed to trigger sync:`, error);
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