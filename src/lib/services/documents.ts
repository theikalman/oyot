import { invoke } from '@tauri-apps/api/core';
import { toasts } from './toast';
import type { Document, DocumentSummary, IndexData } from '../types';

export type DocType = 'journal' | 'note';

export async function loadAllDocuments(): Promise<IndexData> {
    try {
        const data: IndexData = await invoke('get_all_documents');
        return data;
    } catch (error) {
        console.error('Failed to load documents:', error);
        toasts.error('Failed to load documents');
        throw error;
    }
}

export async function loadDocument(id: string): Promise<Document> {
    try {
        const doc: Document = await invoke('get_document', { docId: id });
        return doc;
    } catch (error) {
        console.error('Failed to load document:', error);
        toasts.error('Failed to load document');
        throw error;
    }
}

export async function createDocument(
    docType: DocType,
    title: string,
): Promise<Document> {
    try {
        const doc: Document = await invoke('create_document', {
            docType,
            title,
        });
        return doc;
    } catch (error) {
        console.error('Failed to create document:', error);
        toasts.error('Failed to create document');
        throw error;
    }
}

/**
 * Load all raw Yjs update blobs for a document in insertion order.
 * Returns them as Uint8Array[] ready for loadYjsDocFromUpdates().
 */
export async function loadDocumentLedger(docId: string): Promise<Uint8Array[]> {
    try {
        const blobs: number[][] = await invoke('load_document_ledger', { docId });
        return blobs.map(b => new Uint8Array(b));
    } catch (error) {
        console.error('Failed to load document ledger:', error);
        toasts.error('Failed to load document');
        throw error;
    }
}

/**
 * Persist one Yjs binary update chunk and update the document title.
 */
export async function commitLocalUpdate(
    docId: string,
    updateBlob: Uint8Array,
    title: string,
): Promise<void> {
    await invoke('commit_local_update', {
        docId,
        updateBlob: Array.from(updateBlob),
        title,
    });
}

/**
 * Broadcast a raw Yjs update blob to all gossip peers (no DB write).
 */
export async function broadcastP2PUpdate(
    docId: string,
    updateBlob: Uint8Array,
): Promise<void> {
    await invoke('broadcast_p2p_update', {
        docId,
        updateBlob: Array.from(updateBlob),
    });
}

export async function getOrCreateTodayJournal(): Promise<Document> {
    try {
        const doc: Document = await invoke('get_or_create_today_journal');
        return doc;
    } catch (error) {
        console.error('Failed to get/create today journal:', error);
        toasts.error('Failed to get today journal');
        throw error;
    }
}

export async function cleanupOrphanedImages(): Promise<number> {
    try {
        const count: number = await invoke('cleanup_orphaned_images');
        if (count > 0) {
            console.log(`Cleaned up ${count} orphaned image(s)`);
            toasts.info(`Cleaned up ${count} orphaned image(s)`);
        }
        return count;
    } catch (error) {
        console.error('Failed to cleanup orphaned images:', error);
        return 0;
    }
}

export function toDocumentSummary(doc: Document): DocumentSummary {
    return {
        id: doc.id,
        doc_type: doc.doc_type,
        title: doc.title,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
    };
}
