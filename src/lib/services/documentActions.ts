import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import type { Document } from '../types';
import { appStore } from '../stores/app';
import { toDocumentSummary } from './documents';
import { broadcastDocCreated, broadcastDocRenamed, broadcastDocDeleted } from '../sync';

function appStoreDoc(docId: string) {
    return get(appStore).documents.find((d) => d.id === docId);
}
function appStoreCurrentId(): string | undefined {
    return get(appStore).currentDocument?.id;
}

// Single owner of user-initiated document mutations: run the Rust command,
// update the in-memory store, and tell paired devices. UI components call these
// instead of invoking + broadcasting inline, so the local and the synced paths
// stay identical. See docs/decisions/0003-full-document-set-sync.md.

function announceCreated(doc: Document): void {
    broadcastDocCreated({
        id: doc.id,
        docType: doc.doc_type,
        title: doc.title,
        titleUpdatedAt: doc.title_updated_at,
        createdAt: doc.created_at,
        lifecycleUpdatedAt: doc.lifecycle_updated_at ?? doc.created_at,
    });
}

// Creating does not open. The caller navigates, and the document route sets
// the open document from the URL, so there is exactly one thing that decides
// what is on screen.
export async function createNote(title: string): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'note', title });
    appStore.addDocument(toDocumentSummary(doc));
    announceCreated(doc);
    return doc;
}

export async function createJournalForDate(dateTitle: string): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'journal', title: dateTitle });
    appStore.addDocument(toDocumentSummary(doc));
    announceCreated(doc);
    return doc;
}

// Wraps get_or_create_today_journal, announcing only when there is something
// peers have not heard.
//
// Announcing unconditionally meant every launch broadcast `doc-created` for a
// journal every peer already had, and each of them answered with a `sync-need`
// carrying an empty state vector, so the whole document came back across the
// wire. A revival still counts as news: it is how a peer learns the tombstone
// it holds has been superseded.
export async function ensureTodayJournal(): Promise<Document> {
    const { document: doc, created } = await invoke<{ document: Document; created: boolean }>(
        'get_or_create_today_journal',
    );
    appStore.addDocument(toDocumentSummary(doc));
    if (created) announceCreated(doc);
    return doc;
}

export async function renameDocument(docId: string, title: string): Promise<Document> {
    const doc = await invoke<Document>('update_document', { docId, title });
    const existing = appStoreDoc(docId);
    if (existing) {
        appStore.updateDocumentInList({
            ...existing,
            title: doc.title,
            updated_at: doc.updated_at,
        });
    }
    if (appStoreCurrentId() === docId) {
        appStore.setCurrentDocument(doc);
    }
    broadcastDocRenamed(docId, doc.title, doc.title_updated_at);
    return doc;
}

export async function deleteDocument(docId: string): Promise<void> {
    // Broadcast the stamp Rust actually wrote. Taking a second reading with
    // `Date.now()` here produced one strictly later than the row's, so every
    // peer recorded the delete as marginally newer than ours and handed it
    // back on the next manifest exchange as if it were news.
    const deletedAt = await invoke<number>('delete_document', { docId });
    appStore.removeDocument(docId);
    broadcastDocDeleted(docId, deletedAt);
}
