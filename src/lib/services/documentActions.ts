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
    });
}

export async function createNote(title: string): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'note', title });
    appStore.addDocument(toDocumentSummary(doc));
    appStore.setCurrentDocument(doc);
    announceCreated(doc);
    return doc;
}

export async function createJournalForDate(dateTitle: string): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'journal', title: dateTitle });
    appStore.addDocument(toDocumentSummary(doc));
    appStore.setCurrentDocument(doc);
    announceCreated(doc);
    return doc;
}

// Wraps get_or_create_today_journal so a freshly created journal is announced
// to peers (an already-existing one is a no-op for them).
export async function ensureTodayJournal(): Promise<Document> {
    const doc = await invoke<Document>('get_or_create_today_journal');
    appStore.addDocument(toDocumentSummary(doc));
    announceCreated(doc);
    return doc;
}

export async function renameDocument(docId: string, title: string): Promise<Document> {
    const doc = await invoke<Document>('update_document', { docId, title });
    const existing = appStoreDoc(docId);
    if (existing) {
        appStore.updateDocumentInList({ ...existing, title: doc.title, updated_at: doc.updated_at });
    }
    if (appStoreCurrentId() === docId) {
        appStore.setCurrentDocument(doc);
    }
    broadcastDocRenamed(docId, doc.title, doc.title_updated_at);
    return doc;
}

export async function deleteDocument(docId: string): Promise<void> {
    await invoke('delete_document', { docId });
    appStore.removeDocument(docId);
    broadcastDocDeleted(docId, Date.now());
}
