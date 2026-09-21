import { invoke } from '@tauri-apps/api/core';
import { normalizeTagName, type TagSummary } from '$lib/tiptap/tags';
import type { DocumentSummary } from '$lib/types';
import { broadcastLocalUpdate, documentRepository } from '$lib/sync';
import { bumpIndexRevision } from '$lib/stores/derivedIndex';

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

/** What a rename did, for the message the user gets. */
export interface TagRenameResult {
    from: string;
    to: string;
    /** Documents in which at least one chip changed. */
    documents: number;
    /** Chips rewritten, across all of them. */
    chips: number;
    /** Documents that could not be rewritten; the tag is still in them. */
    failed: number;
}

export class TagRenameError extends Error {}

/**
 * Rename a tag everywhere it appears.
 *
 * There is no registry to rename in (ADR 0019), so this is what a rename is: an
 * edit to every document carrying the tag. Each document is rewritten on its
 * own, through the repository's per-document write queue, and each is saved,
 * re-indexed and broadcast as the local edit it is.
 *
 * That means a rename is not atomic, and cannot be: the documents are separate
 * CRDTs with separate peers. A failure part-way through leaves some documents
 * renamed and some not, which is why the count of what failed is reported
 * rather than swallowed. Running it again finishes the job, because renaming
 * what is already renamed is a no-op.
 *
 * Renaming onto a tag that already exists is allowed, and merges the two. A
 * document that carried both ends up showing the chip twice; the index counts
 * it once, because a document carries a tag or it does not.
 */
export async function renameTag(rawFrom: string, rawTo: string): Promise<TagRenameResult> {
    const from = normalizeTagName(rawFrom);
    const to = normalizeTagName(rawTo);

    if (!from) throw new TagRenameError('There is no tag to rename.');
    if (!to) throw new TagRenameError('A tag needs a name.');
    if (from === to) throw new TagRenameError(`That is already what it is called.`);

    // Read before anything is written. A document that gains the tag while this
    // runs is not renamed, which is the same outcome as gaining it a moment
    // after; a document that loses it is a no-op by the time we get there.
    const targets = await loadDocumentsForTag(from);

    let documents = 0;
    let chips = 0;
    let failed = 0;

    for (const doc of targets) {
        try {
            const { changed, broadcast } = await documentRepository.renameTagIn(doc.id, from, to);
            if (changed > 0) {
                documents++;
                chips += changed;
            }
            // Null when the document is open in the editor, whose own save path
            // broadcasts the edit; sending it here as well would be an echo.
            if (broadcast) broadcastLocalUpdate(doc.id, broadcast);
        } catch (error) {
            console.error(`[tags] could not rename #${from} in ${doc.id}:`, error);
            failed++;
        }
    }

    // The tag list, the tag page and anything else reading derived rows all
    // move at once. The repository bumps this per document it writes, but not
    // for one that was open, and not when every document failed.
    bumpIndexRevision();

    return { from, to, documents, chips, failed };
}
