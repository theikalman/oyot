import { log } from '$lib/log';
import { invoke } from '@tauri-apps/api/core';
import { documentRepository } from '$lib/sync';
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

// Build any missing derived rows, then collect the images nothing references.
//
// The order matters: collection refuses to run while a document still has no
// index, because an unindexed document's images look unreferenced.
export async function reindexAndCollect(): Promise<void> {
    try {
        const indexed = await documentRepository.backfillIndex();
        if (indexed > 0) log.debug(`Built a search index for ${indexed} document(s)`);
    } catch (error) {
        console.error('Failed to backfill document indexes:', error);
    }
    await cleanupOrphanedImages();
}

export async function cleanupOrphanedImages(): Promise<number> {
    try {
        const count: number = await invoke('cleanup_orphaned_images');
        if (count > 0) {
            log.debug(`Cleaned up ${count} orphaned image(s)`);
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
        todo_count: 0,
        completed_todo_count: 0,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        has_content: false,
        pinned: doc.pinned,
    };
}
