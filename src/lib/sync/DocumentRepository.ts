import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import * as Y from 'yjs';
import type { Document, DocumentSummary } from '../types';
import type { DocumentIndex } from '../editor/documentIndex';
import { appStore } from '../stores/app';
import { getOpenDoc, registerOpenDoc } from '../editor/openDocs';
import { REMOTE_ORIGIN } from '../editor/origin';
import { contentHash } from './hash';
import { createWriteQueue } from './writeQueue';
import {
    base64ToBytes,
    bytesToBase64,
    lifecycleStamp,
    EMPTY_UPDATE_LEN,
    type AttachmentManifestEntry,
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
    lifecycle_updated_at: number;
    content_hash: string | null; // base64
}

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
    // Writes to one document are serialised. Both write paths below are
    // read-modify-write over a column that `save_yjs_update` overwrites
    // outright, and the data channel hands us messages without waiting for the
    // previous one to finish, so without this two updates to the same document
    // both start from the same base and one of them is silently dropped.
    private write = createWriteQueue();

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
            lifecycleUpdatedAt: r.lifecycle_updated_at,
            contentHash: r.content_hash,
        }));
    }

    private async loadDoc(docId: string): Promise<Y.Doc> {
        const res = await invoke<{ doc_id: string; state: string }>('get_yjs_state', { docId });
        const ydoc = new Y.Doc();
        if (res.state) {
            Y.applyUpdate(ydoc, base64ToBytes(res.state));
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

    // Hand the editor the document's state as a Y.Doc, registered as the open
    // copy so inbound merges can be applied straight into it.
    //
    // Reading the state and registering happen as one queued operation on
    // purpose. If a merge could land in the gap between the two, the editor
    // would open on content that is already stale and then save over the newer
    // copy. Queueing closes that window without a second lock.
    //
    // The caller must `unregisterOpenDoc` before it stops using the Y.Doc.
    async openDocument(docId: string): Promise<Y.Doc> {
        return this.write(docId, async () => {
            const ydoc = await this.loadDoc(docId);
            registerOpenDoc(docId, ydoc);
            return ydoc;
        });
    }

    // Merge an inbound update (delta or live edit) into local storage.
    //
    // When the document is open, the editor's Y.Doc is the copy to merge into:
    // it is at least as advanced as the stored state, and applying there is
    // what puts a peer's edit on screen. The editor is not told to reload
    // afterwards, because it is already holding the merged document.
    async mergeDelta(docId: string, updateB64: string): Promise<void> {
        const updateBytes = base64ToBytes(updateB64);
        return this.write(docId, async () => {
            const live = getOpenDoc(docId);
            let merged: Uint8Array;
            if (live) {
                // No await between the lookup and the encode: both calls are
                // synchronous, so the editor cannot swap the document out from
                // under this merge.
                Y.applyUpdate(live, updateBytes, REMOTE_ORIGIN);
                merged = Y.encodeStateAsUpdate(live);
            } else {
                const current = await this.loadDoc(docId);
                Y.applyUpdate(current, updateBytes);
                merged = Y.encodeStateAsUpdate(current);
                current.destroy();
            }
            const hash = await contentHash(merged);
            await invoke('save_yjs_update', {
                docId,
                update: bytesToBase64(updateBytes),
                mergedState: bytesToBase64(merged),
                contentHash: bytesToBase64(hash),
                origin: 'remote',
                index: null,
            });
            appStore.markDocumentHasContent(docId);
        });
    }

    // Persist a locally-made update (editor save path). 'local' suppresses the
    // sync-received event: the editor that produced this already has it.
    //
    // `index` is what the editor extracted from the rendered document (text,
    // links, todo counts). Only this path has it: the sync path merges a peer's
    // update without ever rendering it, so it passes none and the derived rows
    // are left for whenever that document is next opened and saved.
    async saveLocalUpdate(
        docId: string,
        mergedState: Uint8Array,
        index?: DocumentIndex,
    ): Promise<void> {
        return this.write(docId, async () => {
            // `mergedState` was encoded by the caller before it queued, so a
            // merge that ran while it waited is missing from it. Fold it back
            // into the live document and re-encode, and the write is the union
            // of both rather than whichever copy was encoded last.
            const live = getOpenDoc(docId);
            let state = mergedState;
            if (live) {
                Y.applyUpdate(live, mergedState, REMOTE_ORIGIN);
                state = Y.encodeStateAsUpdate(live);
            }
            const hash = await contentHash(state);
            await invoke('save_yjs_update', {
                docId,
                update: bytesToBase64(state),
                mergedState: bytesToBase64(state),
                contentHash: bytesToBase64(hash),
                origin: 'local',
                index: index ?? null,
            });
        });
    }

    // Materialize a document row learned from a peer. Never clobbers a known row.
    async ensureDoc(entry: ManifestEntry): Promise<void> {
        const doc = await invoke<Document>('ensure_document', {
            entry: {
                docId: entry.id,
                docType: entry.docType,
                title: entry.title,
                createdAt: entry.createdAt,
                updatedAt: entry.titleUpdatedAt,
                titleUpdatedAt: entry.titleUpdatedAt,
                lifecycleUpdatedAt: lifecycleStamp(entry),
            },
        });
        appStore.addDocument(toSummary(doc));
    }

    // Record a peer's tombstone for a document we have never held, so the
    // delete keeps propagating instead of stopping here.
    //
    // Deliberately does not touch the sidebar store: there is nothing to show,
    // and `ensureDoc` adding a row is what would make a deleted document
    // appear in the list.
    async ensureTombstone(entry: ManifestEntry): Promise<void> {
        await invoke('ensure_tombstone', {
            entry: {
                docId: entry.id,
                docType: entry.docType,
                title: entry.title,
                createdAt: entry.createdAt,
                updatedAt: entry.titleUpdatedAt,
                titleUpdatedAt: entry.titleUpdatedAt,
                deletedAt: entry.deletedAt,
                lifecycleUpdatedAt: lifecycleStamp(entry),
            },
        });
    }

    async applyRename(docId: string, title: string, titleUpdatedAt: number): Promise<void> {
        const changed = await invoke<boolean>('apply_remote_rename', {
            docId,
            title,
            titleUpdatedAt,
        });
        if (!changed) return;
        const existing = get(appStore).documents.find((d) => d.id === docId);
        if (existing) {
            appStore.updateDocumentInList({ ...existing, title, updated_at: titleUpdatedAt });
        }
    }

    // Returns true if the tombstone won. A losing tombstone (we revived the
    // document after the peer deleted it) must not remove it from the sidebar.
    async applyDelete(docId: string, deletedAt: number): Promise<boolean> {
        const applied = await invoke<boolean>('apply_remote_delete', { docId, deletedAt });
        if (applied) appStore.removeDocument(docId);
        return applied;
    }

    // --- attachments ---------------------------------------------------

    // Every image binary we hold in full, to advertise to a peer.
    async listAttachments(): Promise<AttachmentManifestEntry[]> {
        const rows = await invoke<{ hash: string; mime_type: string; size: number }[]>(
            'list_attachment_manifest',
        );
        return rows.map((r) => ({ hash: r.hash, mime: r.mime_type, size: r.size }));
    }

    // Do we already have this attachment's bytes on disk?
    async hasAttachment(hash: string): Promise<boolean> {
        const info = await invoke<{ is_fully_downloaded: boolean } | null>('get_attachment_info', {
            hash,
        });
        return !!info && info.is_fully_downloaded;
    }

    // The bytes for a peer's `attach-need`, or null if we do not have them.
    async readAttachment(hash: string): Promise<{ mime: string; data: string } | null> {
        const res = await invoke<{ mime_type: string; data: string } | null>(
            'get_attachment_bytes',
            {
                hash,
            },
        );
        return res ? { mime: res.mime_type, data: res.data } : null;
    }

    // Persist an attachment pulled from a peer. Rejects on hash mismatch.
    async saveAttachment(hash: string, mime: string, data: string): Promise<void> {
        await invoke('save_attachment_bytes', { hash, mimeType: mime, data });
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
                await invoke('set_content_hash', {
                    docId: row.id,
                    contentHash: bytesToBase64(hash),
                });
            } catch (e) {
                console.warn(`[sync] hash backfill failed for ${row.id}:`, e);
            }
        }
    }
}
