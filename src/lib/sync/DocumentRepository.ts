import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import * as Y from 'yjs';
import type { Document, DocumentSummary } from '../types';
import { appStore } from '../stores/app';
import { contentHash } from './hash';
import {
    base64ToBytes,
    bytesToBase64,
    type ManifestEntry,
} from './protocol';

// Rust `DocSyncEntry` shape (snake_case, hash as a byte array).
interface RawSyncEntry {
    id: string;
    doc_type: string;
    title: string;
    created_at: number;
    updated_at: number;
    title_updated_at: number;
    is_deleted: boolean;
    deleted_at: number | null;
    content_hash: number[] | null;
}

// Yjs' encoding of "no missing operations": a bare, empty update.
const EMPTY_UPDATE_LEN = 2;

function toSummary(doc: Document): DocumentSummary {
    return {
        id: doc.id,
        doc_type: doc.doc_type,
        title: doc.title,
        todo_count: 0,
        completed_todo_count: 0,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        has_content: false,
    };
}

// The single boundary between the sync protocol and (Tauri commands + Yjs). All
// CRDT diffing/merging and every document mutation the sync layer performs goes
// through here, and the in-memory document store is kept in step so the sidebar
// reflects a converging set live.
export class DocumentRepository {
    // --- reads -------------------------------------------------------------

    async listSyncState(): Promise<ManifestEntry[]> {
        const rows = await invoke<RawSyncEntry[]>('list_document_sync_state');
        return rows.map((r) => ({
            id: r.id,
            docType: r.doc_type,
            title: r.title,
            titleUpdatedAt: r.title_updated_at,
            createdAt: r.created_at,
            isDeleted: r.is_deleted,
            deletedAt: r.deleted_at,
            contentHash: r.content_hash ? bytesToBase64(Uint8Array.from(r.content_hash)) : null,
        }));
    }

    private async loadDoc(docId: string): Promise<Y.Doc> {
        const res = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', { docId });
        const ydoc = new Y.Doc();
        if (res.state && res.state.length > 0) {
            Y.applyUpdate(ydoc, new Uint8Array(res.state));
        }
        return ydoc;
    }

    // base64(state vector) of our copy; the empty-doc vector when we have nothing.
    async localStateVector(docId: string): Promise<string> {
        const ydoc = await this.loadDoc(docId);
        return bytesToBase64(Y.encodeStateVector(ydoc));
    }

    // The delta a peer at `remoteSvB64` is missing from our copy, or null if
    // none. An empty `remoteSvB64` means "send everything".
    async computeDelta(docId: string, remoteSvB64: string): Promise<string | null> {
        const ydoc = await this.loadDoc(docId);
        const diff = remoteSvB64
            ? Y.encodeStateAsUpdate(ydoc, base64ToBytes(remoteSvB64))
            : Y.encodeStateAsUpdate(ydoc);
        if (diff.length <= EMPTY_UPDATE_LEN) return null;
        return bytesToBase64(diff);
    }

    // --- writes ----------------------------------------------------------

    // Merge an inbound update (delta or live edit) into local storage,
    // regardless of whether the doc is open. Reuses save_yjs_update so it emits
    // the 'sync-received' event the editor listens for.
    async mergeDelta(docId: string, updateB64: string): Promise<void> {
        const updateBytes = base64ToBytes(updateB64);
        const current = await this.loadDoc(docId);
        Y.applyUpdate(current, updateBytes);
        const merged = Y.encodeStateAsUpdate(current);
        const hash = await contentHash(merged);
        await invoke('save_yjs_update', {
            docId,
            update: Array.from(updateBytes),
            mergedState: Array.from(merged),
            contentHash: Array.from(hash),
        });
        appStore.markDocumentHasContent(docId);
    }

    // Persist a locally-made update (editor save path).
    async saveLocalUpdate(docId: string, mergedState: Uint8Array): Promise<void> {
        const hash = await contentHash(mergedState);
        await invoke('save_yjs_update', {
            docId,
            update: Array.from(mergedState),
            mergedState: Array.from(mergedState),
            contentHash: Array.from(hash),
        });
    }

    // Materialize a document row learned from a peer. Never clobbers a known row.
    async ensureDoc(entry: ManifestEntry): Promise<void> {
        const doc = await invoke<Document>('ensure_document', {
            docId: entry.id,
            docType: entry.docType,
            title: entry.title,
            createdAt: entry.createdAt,
            updatedAt: entry.titleUpdatedAt,
            titleUpdatedAt: entry.titleUpdatedAt,
        });
        appStore.addDocument(toSummary(doc));
    }

    async applyRename(docId: string, title: string, titleUpdatedAt: number): Promise<void> {
        const changed = await invoke<boolean>('apply_remote_rename', { docId, title, titleUpdatedAt });
        if (!changed) return;
        const existing = get(appStore).documents.find((d) => d.id === docId);
        if (existing) {
            appStore.updateDocumentInList({ ...existing, title, updated_at: titleUpdatedAt });
        }
    }

    async applyDelete(docId: string, deletedAt: number): Promise<void> {
        await invoke('apply_remote_delete', { docId, deletedAt });
        appStore.removeDocument(docId);
    }

    // --- one-time maintenance -------------------------------------------

    // Backfill content hashes for rows written before the hashing code existed.
    // Cheap, idempotent, runs once off the critical path after an upgrade.
    async backfillHashes(): Promise<void> {
        const rows = await this.listSyncState();
        for (const row of rows) {
            if (row.isDeleted || row.contentHash) continue;
            try {
                const ydoc = await this.loadDoc(row.id);
                const state = Y.encodeStateAsUpdate(ydoc);
                if (state.length <= EMPTY_UPDATE_LEN) continue;
                const hash = await contentHash(state);
                await invoke('set_content_hash', { docId: row.id, contentHash: Array.from(hash) });
            } catch (e) {
                console.warn(`[sync] hash backfill failed for ${row.id}:`, e);
            }
        }
    }
}
