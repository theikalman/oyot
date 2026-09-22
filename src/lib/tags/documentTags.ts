// Which tags each document carries.
//
// `get_document_tags` answers in rows -- one per document per tag -- because
// that is what SQL has. What every caller wants is a document's tags together,
// so the turn from one into the other happens once, here, where it can be
// tested without IPC.

/** One tag on one document, as SQL reports it. */
export interface DocumentTagHit {
    document_id: string;
    /** Normalized, as every stored tag is. */
    name: string;
}

/** A document's tags, in the order they should be shown. */
export type TagsByDocument = ReadonlyMap<string, string[]>;

/**
 * Gather the rows by document, keeping the order they arrive in.
 *
 * The query orders by document and then by name, so the chips on a row read
 * the same way every time the page is opened. Nothing is sorted here, and
 * nothing assumes a document's rows are contiguous: the map does not care.
 */
export function tagsByDocument(hits: DocumentTagHit[]): TagsByDocument {
    const byDocument = new Map<string, string[]>();

    for (const hit of hits) {
        const tags = byDocument.get(hit.document_id);
        if (tags) tags.push(hit.name);
        else byDocument.set(hit.document_id, [hit.name]);
    }

    return byDocument;
}

/** The tags for one document, or nothing if it carries none. */
export function tagsOf(byDocument: TagsByDocument, docId: string): string[] {
    return byDocument.get(docId) ?? [];
}

/** Nothing tagged, for a caller with no rows to hand over yet. */
export const NO_TAGS: TagsByDocument = new Map<string, string[]>();
