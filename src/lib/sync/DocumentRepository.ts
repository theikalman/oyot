import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import * as Y from 'yjs';
import type { Document, DocumentSummary } from '../types';
import type { DocumentIndex } from '../editor/documentIndex';
import { appStore } from '../stores/app';
import { bumpIndexRevision } from '../stores/derivedIndex';
import { getOpenDoc, registerOpenDoc } from '../editor/openDocs';
import { REMOTE_ORIGIN } from '../editor/origin';
import { renameTagInDoc } from '../tags/renameInDoc';
import { createWriteQueue } from './writeQueue';
import { base64ToBytes, bytesToBase64, lifecycleStamp, type ManifestEntry } from './protocol';

// Reading an index out of a document needs the editor's schema, and that
// module imports back through to this one. A static import would make the two
// circular at load time; a deferred one resolves after both are built.
// Cached, including the failure, so a broken load is not retried per document.
type HeadlessIndexer = (ydoc: Y.Doc) => DocumentIndex;
let indexerLoad: Promise<HeadlessIndexer | null> | null = null;

function loadIndexer(): Promise<HeadlessIndexer | null> {
    indexerLoad ??= import('../editor/headlessIndex')
        .then((m) => m.indexFromYDoc)
        .catch((e) => {
            console.warn('[sync] no headless indexer available, documents will index on open:', e);
            return null;
        });
    return indexerLoad;
}

// Never let indexing cost us the content. A document whose schema this build
// does not recognise is still stored; it just goes unindexed until someone
// opens it.
function readIndex(indexer: HeadlessIndexer | null, ydoc: Y.Doc): DocumentIndex | null {
    if (!indexer) return null;
    try {
        return indexer(ydoc);
    } catch (e) {
        console.warn('[sync] could not index a document:', e);
        return null;
    }
}

// How long after a peer's edit lands in the open document to index it. A
// peer typing sends an update every few hundred milliseconds, and the index
// only has to have caught up once they stop.
const OPEN_INDEX_DELAY_MS = 500;

// Rust `DocSyncEntry` shape: snake_case, the hash already base64. A backup
// being imported describes its documents in the same shape.
export interface RawSyncEntry {
    id: string;
    doc_type: string;
    title: string;
    created_at: number;
    updated_at: number;
    title_updated_at: number;
    is_deleted: boolean;
    deleted_at: number | null;
    lifecycle_updated_at: number;
    pinned: boolean;
    pinned_updated_at: number | null;
    content_hash: string | null; // base64
}

export function toManifestEntry(r: RawSyncEntry): ManifestEntry {
    return {
        id: r.id,
        docType: r.doc_type,
        title: r.title,
        titleUpdatedAt: r.title_updated_at,
        createdAt: r.created_at,
        isDeleted: r.is_deleted,
        deletedAt: r.deleted_at,
        lifecycleUpdatedAt: r.lifecycle_updated_at,
        pinned: r.pinned,
        pinnedUpdatedAt: r.pinned_updated_at,
        contentHash: r.content_hash,
    };
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
        pinned: doc.pinned,
    };
}

// A document a peer made, as the sidebar lists it before its content arrives.
function summaryOf(entry: ManifestEntry): DocumentSummary {
    return {
        id: entry.id,
        doc_type: entry.docType,
        title: entry.title,
        todo_count: 0,
        completed_todo_count: 0,
        created_at: entry.createdAt,
        updated_at: entry.titleUpdatedAt,
        has_content: false,
        pinned: entry.pinned ?? false,
    };
}

// What `save_yjs_update` hands back: the stored state vector after the merge,
// base64, or empty when there was no live row to save into.
interface SavedState {
    state_vector: string;
}

// What `get_yjs_state` hands back.
interface StoredState {
    state: string;
    content_hash: string | null;
}

// The page's side of documents: the only place Tauri's document commands and
// Yjs meet. Rust merges what is saved into the stored state, hashes it, and
// tells connected devices (ADR 0031, decisions 3, 4 and 6). A peer's changes
// are merged by Rust and arrive here as events, to be put on screen, into
// the sidebar and into the index (decisions 5, 7 and 9).
export class DocumentRepository {
    // Work on one document is serialised. Rust merges rather than overwrites,
    // so a write can no longer erase another, but the steps the page takes
    // around a write still have to happen in order: opening a document reads
    // its state and registers it in one step, and a peer's update is applied
    // to the open copy only once that copy is registered.
    private write = createWriteQueue();

    // The stored state vector each document had after its last save here, so
    // the editor's next save carries only what the store is missing (ADR 0031,
    // decision 4). A save computed against one that has since moved on sends
    // a little more than it needs to, never less.
    private storedStateVectors = new Map<string, Uint8Array>();

    // Open documents waiting to be indexed after a peer's edit.
    private openIndexTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // One backfill at a time: coming back on screen while one runs has
    // nothing to add to it.
    private backfill: Promise<number> | null = null;

    private async save(
        docId: string,
        update: Uint8Array,
        index: DocumentIndex | null,
        quiet = false,
    ): Promise<void> {
        const saved = await invoke<SavedState | undefined>('save_yjs_update', {
            docId,
            update: bytesToBase64(update),
            index,
            quiet,
        });
        if (saved?.state_vector) {
            this.storedStateVectors.set(docId, base64ToBytes(saved.state_vector));
        } else {
            this.storedStateVectors.delete(docId);
        }
    }

    // --- reads -------------------------------------------------------------

    async listSyncState(): Promise<ManifestEntry[]> {
        const rows = await invoke<RawSyncEntry[]>('list_document_sync_state');
        return rows.map(toManifestEntry);
    }

    private async loadDoc(docId: string): Promise<{ ydoc: Y.Doc; contentHash: string | null }> {
        const res = await invoke<StoredState>('get_yjs_state', { docId });
        const ydoc = new Y.Doc();
        if (res.state) {
            Y.applyUpdate(ydoc, base64ToBytes(res.state));
        }
        return { ydoc, contentHash: res.content_hash };
    }

    // --- writes ----------------------------------------------------------

    // Hand the editor the document's state as a Y.Doc, registered as the open
    // copy so a peer's updates can be applied straight into it.
    //
    // Reading the state and registering happen as one queued operation on
    // purpose. A peer's update that Rust merged after the read arrives as an
    // event queued behind this, and finds the copy registered; one merged
    // before the read is already in it.
    //
    // The caller must `unregisterOpenDoc` before it stops using the Y.Doc.
    async openDocument(docId: string): Promise<Y.Doc> {
        return this.write(docId, async () => {
            const { ydoc } = await this.loadDoc(docId);
            // The store's own vector, so the first save sends only the edit.
            this.storedStateVectors.set(docId, Y.encodeStateVector(ydoc));
            registerOpenDoc(docId, ydoc);
            return ydoc;
        });
    }

    /**
     * Merge content from a backup into a document, applied to the open copy
     * if there is one, and tell connected devices, as a user's own edit does.
     */
    async mergeDelta(docId: string, updateB64: string): Promise<void> {
        await this.merge(docId, base64ToBytes(updateB64), true, false);
    }

    /**
     * Store content made outside the editor, an imported file's, merged into
     * whatever the document already holds, never written over it. The note
     * may have been opened and typed in since it was created.
     *
     * Saved quietly, since peers pull it when the note is announced with the
     * rest of its batch, and without refreshing anything that reads derived
     * rows: an import saves notes one after another and refreshes those once
     * per batch (`$lib/import`). Returns the index written, for the import to
     * show the counts with.
     */
    async importContent(docId: string, update: Uint8Array): Promise<DocumentIndex | null> {
        return this.merge(docId, update, false, true);
    }

    private async merge(
        docId: string,
        updateBytes: Uint8Array,
        refresh: boolean,
        quiet: boolean,
    ): Promise<DocumentIndex | null> {
        return this.write(docId, async () => {
            // Resolved before the document is touched, so the merge below
            // stays synchronous from lookup to encode.
            const indexer = await loadIndexer();

            const live = getOpenDoc(docId);
            let index: DocumentIndex | null;
            if (live) {
                // No await between the lookup and the apply: both are
                // synchronous, so the editor cannot swap the document out from
                // under this merge.
                Y.applyUpdate(live, updateBytes, REMOTE_ORIGIN);
                index = readIndex(indexer, live);
            } else {
                // Loaded only to read the index from. The stored state is
                // Rust's to merge into.
                const { ydoc } = await this.loadDoc(docId);
                Y.applyUpdate(ydoc, updateBytes);
                index = readIndex(indexer, ydoc);
                ydoc.destroy();
            }
            await this.save(docId, updateBytes, index, quiet);
            if (refresh) this.showIndex(docId, index);
            return index;
        });
    }

    // Persist a locally-made update (editor save path). Rust sends connected
    // devices whatever it adds to the store.
    //
    // `index` is what the editor extracted from the rendered document (text,
    // links, todo counts).
    async saveLocalUpdate(
        docId: string,
        mergedState: Uint8Array,
        index?: DocumentIndex,
    ): Promise<void> {
        return this.write(docId, async () => {
            // `mergedState` was encoded by the caller before it queued, so a
            // peer's update applied while it waited is missing from it. Fold
            // it back into the live document, so the editor's copy is the
            // union of both, and send what the store does not have yet.
            const live = getOpenDoc(docId);
            let update = mergedState;
            if (live) {
                Y.applyUpdate(live, mergedState, REMOTE_ORIGIN);
                const stored = this.storedStateVectors.get(docId);
                update = stored ? Y.encodeStateAsUpdate(live, stored) : Y.encodeStateAsUpdate(live);
            }
            await this.save(docId, update, index ?? null);
            if (index) bumpIndexRevision();
        });
    }

    /**
     * Rewrite one document's `#from` chips to say `#to`, and return how many
     * changed.
     *
     * Queued like every other write to a document, so it cannot interleave
     * with a save or a peer's update to the same one. An open document is
     * edited in its live Y.Doc, whose update listener saves it like any
     * other edit; a closed one is saved here. Either way the save is what
     * tells connected devices.
     */
    async renameTagIn(docId: string, from: string, to: string): Promise<number> {
        return this.write(docId, async () => {
            // Resolved before the document is touched, so the edit below stays
            // synchronous from lookup to encode.
            const indexer = await loadIndexer();

            // No await between the lookup and the encode: the editor cannot
            // swap the document out from under an edit that never yields.
            const live = getOpenDoc(docId);
            if (live) return renameTagInDoc(live, from, to);

            const { ydoc } = await this.loadDoc(docId);
            const before = Y.encodeStateVector(ydoc);
            const changed = renameTagInDoc(ydoc, from, to);
            if (changed === 0) {
                ydoc.destroy();
                return 0;
            }

            // The delta is what the rename added, not the document.
            const delta = Y.encodeStateAsUpdate(ydoc, before);
            const index = readIndex(indexer, ydoc);
            ydoc.destroy();

            await this.save(docId, delta, index);
            bumpIndexRevision();
            return changed;
        });
    }

    // Materialize a document row from a backup being imported. Never clobbers
    // a known row: the pin, like the title, is only taken when the row is new.
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
                pinned: entry.pinned ?? false,
                pinnedUpdatedAt: entry.pinnedUpdatedAt ?? null,
            },
        });
        appStore.addDocument(toSummary(doc));
    }

    // Record a backup's tombstone for a document this device has never held,
    // so the delete keeps propagating instead of stopping here.
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
        if (changed) this.peerRenamed(docId, title, titleUpdatedAt);
    }

    // Last-writer-wins on the pin stamp, decided in Rust by the same rule
    // `reconcile()` uses. The sidebar only moves when the row did.
    async applyPin(docId: string, pinned: boolean, pinnedUpdatedAt: number): Promise<void> {
        const changed = await invoke<boolean>('apply_remote_pin', {
            docId,
            pinned,
            pinnedUpdatedAt,
        });
        if (changed) this.peerPinned(docId, pinned, pinnedUpdatedAt);
    }

    // Returns true if the tombstone won. A losing tombstone (the document was
    // revived after it was deleted) must not remove it from the sidebar.
    async applyDelete(docId: string, deletedAt: number): Promise<boolean> {
        const applied = await invoke<boolean>('apply_remote_delete', { docId, deletedAt });
        if (applied) this.peerDeleted(docId);
        return applied;
    }

    // --- what a peer changed, which Rust has already stored --------------

    peerCreated(entry: ManifestEntry): void {
        appStore.addDocument(summaryOf(entry));
    }

    peerRenamed(docId: string, title: string, titleUpdatedAt: number): void {
        // The todo index groups by title, so a rename moves every one of this
        // document's items under a new heading.
        bumpIndexRevision();
        const existing = get(appStore).documents.find((d) => d.id === docId);
        if (existing) {
            appStore.updateDocumentInList({ ...existing, title, updated_at: titleUpdatedAt });
        }
    }

    peerPinned(docId: string, pinned: boolean, pinnedUpdatedAt: number): void {
        appStore.setDocumentPinned(docId, pinned, pinnedUpdatedAt);
    }

    peerDeleted(docId: string): void {
        appStore.removeDocument(docId);
        bumpIndexRevision();
    }

    /**
     * A peer's update, which Rust has merged into the store (ADR 0031,
     * decision 5). Applied to the open copy with `REMOTE_ORIGIN`, so the
     * editor shows it and does not send it back, then indexed: the open copy
     * shortly after, the stored state of a closed one at once (decision 7).
     */
    async peerMerged(docId: string, updateB64: string): Promise<void> {
        const update = base64ToBytes(updateB64);
        return this.write(docId, async () => {
            const live = getOpenDoc(docId);
            if (live) {
                Y.applyUpdate(live, update, REMOTE_ORIGIN);
                appStore.markDocumentHasContent(docId);
                this.indexOpenSoon(docId);
                return;
            }
            await this.indexStored(docId);
        });
    }

    private indexOpenSoon(docId: string): void {
        clearTimeout(this.openIndexTimers.get(docId));
        this.openIndexTimers.set(
            docId,
            setTimeout(() => {
                this.openIndexTimers.delete(docId);
                void this.write(docId, async () => {
                    const indexer = await loadIndexer();
                    const live = getOpenDoc(docId);
                    if (!live) return this.indexStored(docId);
                    const index = readIndex(indexer, live);
                    if (!index) return;
                    // The open copy holds everything merged into the store
                    // that has reached this page, so the index is taken as
                    // it is; anything merged since has its own turn queued.
                    await invoke('save_document_index', { docId, index, contentHash: null });
                    this.showIndex(docId, index);
                }).catch((e) => console.warn(`[sync] could not index ${docId}:`, e));
            }, OPEN_INDEX_DELAY_MS),
        );
    }

    // Index a document from its stored state. Rust drops the index if the
    // document changed after it was read, and the change that moved it
    // brings its own turn. Returns whether it was written.
    private async indexStored(docId: string): Promise<boolean> {
        const indexer = await loadIndexer();
        if (!indexer) return false;
        const { ydoc, contentHash } = await this.loadDoc(docId);
        const index = readIndex(indexer, ydoc);
        ydoc.destroy();
        if (!index) return false;
        const written = await invoke<boolean>('save_document_index', {
            docId,
            index,
            contentHash,
        });
        if (written) this.showIndex(docId, index);
        return written;
    }

    // A document's index changed: its counts in the sidebar, and every view
    // that reads derived rows, catch up.
    private showIndex(docId: string, index: DocumentIndex | null): void {
        appStore.markDocumentHasContent(docId);
        if (index) {
            appStore.setDocumentCounts(docId, index.todoCount, index.completedTodoCount);
            bumpIndexRevision();
        }
    }

    // --- attachments ---------------------------------------------------

    // Do we already have this attachment's bytes on disk?
    async hasAttachment(hash: string): Promise<boolean> {
        const info = await invoke<{ is_fully_downloaded: boolean } | null>('get_attachment_info', {
            hash,
        });
        return !!info && info.is_fully_downloaded;
    }

    // --- catching up ---------------------------------------------------

    // Build the derived rows for every document that does not have current
    // ones: never indexed, indexed by an older build, or merged by Rust while
    // no page was running to index it (ADR 0031, decision 7).
    //
    // Search, backlinks, task counts and attachment references are all read
    // out of a rendered document, which is why collecting images has to wait
    // for this to finish. One document at a time, off the startup critical
    // path; a failure on one is logged and the rest continue.
    backfillIndex(): Promise<number> {
        this.backfill ??= this.runBackfill().finally(() => {
            this.backfill = null;
        });
        return this.backfill;
    }

    private async runBackfill(): Promise<number> {
        if (!(await loadIndexer())) return 0;

        let ids: string[];
        try {
            ids = await invoke<string[]>('list_unindexed_documents');
        } catch (e) {
            console.warn('[sync] could not list documents needing an index:', e);
            return 0;
        }

        let done = 0;
        for (const docId of ids) {
            try {
                if (await this.write(docId, () => this.indexStored(docId))) done++;
            } catch (e) {
                console.warn(`[sync] could not index ${docId}:`, e);
            }
        }
        return done;
    }
}
