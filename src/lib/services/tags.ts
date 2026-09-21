import { invoke } from '@tauri-apps/api/core';
import { normalizeTagName, type TagSummary } from '$lib/tiptap/tags';
import type { DocumentSummary } from '$lib/types';

/** One tag row, as SQL reports it. */
interface TagHit {
    name: string;
    document_count: number;
}

/**
 * Every tag in the corpus, most used first.
 *
 * Read from the derived rows rather than the documents themselves, for the
 * reason ADR 0017 gives for todos: rendering every document to answer a
 * question the user asks several times a session is work that only needs doing
 * when a document is written.
 *
 * Failure returns nothing rather than throwing. The picker's other half is the
 * open document's own tags and the ability to coin a new one, both of which
 * still work with no list at all, so a failed query should cost the suggestions
 * and not the feature.
 */
export async function loadAllTags(): Promise<TagSummary[]> {
    try {
        const hits = await invoke<TagHit[]>('get_all_tags');
        return hits.map((hit) => ({ name: hit.name, documentCount: hit.document_count }));
    } catch (error) {
        console.error('[tags] failed to load the tag list:', error);
        return [];
    }
}

/**
 * The live documents carrying `name`, journals first, each group in the order
 * the todo index uses.
 *
 * Throws rather than swallowing, unlike `loadAllTags`: this answers the whole
 * of the page it feeds, and an empty list would read as "no note mentions this
 * tag" when the truth is that nothing was asked.
 */
export async function loadDocumentsForTag(name: string): Promise<DocumentSummary[]> {
    return invoke<DocumentSummary[]>('get_documents_by_tag', { name: normalizeTagName(name) });
}
