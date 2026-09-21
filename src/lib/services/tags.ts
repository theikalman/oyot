import { invoke } from '@tauri-apps/api/core';
import type { TagSummary } from '$lib/tiptap/tags';

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
