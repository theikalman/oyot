import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import type { Document } from '../types';
import type { DocumentIndex } from '../editor/documentIndex';
import { appStore } from '../stores/app';
import { bumpIndexRevision } from '../stores/derivedIndex';
import { toDocumentSummary } from './documents';

function appStoreDoc(docId: string) {
    return get(appStore).documents.find((d) => d.id === docId);
}
function appStoreCurrentId(): string | undefined {
    return get(appStore).currentDocument?.id;
}

// Single owner of user-initiated document mutations: run the Rust command and
// update the in-memory store. UI components call these instead of invoking
// inline, so every path keeps the store the same way. Each command tells
// connected devices itself (ADR 0031, decision 6).

// Creating does not open. The caller navigates, and the document route sets
// the open document from the URL, so there is exactly one thing that decides
// what is on screen.
//
// `pinned` is decided in the same write as the note itself, rather than by
// pinning it afterwards, so there is never a moment when the note exists and
// is not yet where the user asked for it.
export async function createNote(title: string, pinned = false): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'note', title, pinned });
    appStore.addDocument(toDocumentSummary(doc));
    return doc;
}

// An imported note is made in two steps, with its content saved in between
// (ADR 0029). The row comes first, under the id the other imported notes'
// links were written with, and tells no one: the sidebar would list a note
// with nothing in it yet, and a peer told now would pull content that is not
// there.
export async function createImportedNote(id: string, title: string): Promise<Document> {
    return invoke<Document>('create_document', {
        docType: 'note',
        title,
        pinned: false,
        id,
        quiet: true,
    });
}

export interface PublishedNote {
    doc: Document;
    hasContent: boolean;
    /** What was indexed from its content, for the counts beside it. */
    index: DocumentIndex | null;
}

// Once their content is saved: list a batch of imported notes at once, and
// tell paired devices, each of which pulls a note's content on hearing of it.
// One store update and one refresh of the derived views for the batch, rather
// than one each per note, which on a large import redraws every list
// thousands of times.
export function publishImportedNotes(notes: PublishedNote[]): void {
    if (notes.length === 0) return;
    appStore.addDocuments(
        notes.map(({ doc, hasContent, index }) => ({
            ...toDocumentSummary(doc),
            has_content: hasContent,
            todo_count: index?.todoCount ?? 0,
            completed_todo_count: index?.completedTodoCount ?? 0,
        })),
    );
    bumpIndexRevision();
    void invoke('announce_documents', { ids: notes.map(({ doc }) => doc.id) }).catch((e) =>
        console.warn('[import] could not tell connected devices about the imported notes:', e),
    );
}

export async function createJournalForDate(dateTitle: string): Promise<Document> {
    const doc = await invoke<Document>('create_document', { docType: 'journal', title: dateTitle });
    appStore.addDocument(toDocumentSummary(doc));
    return doc;
}

// Rust announces today's journal only when it made or revived it: every peer
// already has one that was sitting there.
export async function ensureTodayJournal(): Promise<Document> {
    const { document: doc } = await invoke<{ document: Document; created: boolean }>(
        'get_or_create_today_journal',
    );
    appStore.addDocument(toDocumentSummary(doc));
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
    // Views grouped by title, the todo index among them, have to regroup.
    bumpIndexRevision();
    return doc;
}

// Pinning keeps a note in the sidebar, on every device: it is the user's
// choice about the note, like its title (ADR 0027). The stamp comes back from
// Rust, which wrote it.
export async function setPinned(docId: string, pinned: boolean): Promise<void> {
    const pinnedUpdatedAt = await invoke<number>('set_document_pinned', { docId, pinned });
    appStore.setDocumentPinned(docId, pinned, pinnedUpdatedAt);
}

export async function deleteDocument(docId: string): Promise<void> {
    await invoke<number>('delete_document', { docId });
    appStore.removeDocument(docId);
    // Its derived rows went with it, so anything reading them is now stale.
    bumpIndexRevision();
}
