import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { createContentExtensions } from './extensions';
import { extractDocumentIndex, type DocumentIndex } from './documentIndex';
import { CONTENT_FIELD } from './contentField';

// Built once. Deriving a schema walks every extension, and this runs on the
// sync path where a first pair can merge hundreds of documents in a row.
let cached: Schema | null = null;

function schema(): Schema {
    cached ??= getSchema(createContentExtensions());
    return cached;
}

/**
 * Read a document's searchable text, outgoing links and task counts without an
 * editor.
 *
 * Only the editor could do this before, so a document merged from a peer was
 * written with no index at all: invisible to search, contributing no backlinks,
 * and counted as having no tasks, until the day someone happened to open and
 * edit it on this device. Rendering the merged CRDT against the same schema the
 * editor uses closes that gap at the point the content arrives.
 */
export function indexFromYDoc(ydoc: Y.Doc): DocumentIndex {
    const root = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(CONTENT_FIELD), schema());
    return extractDocumentIndex(root);
}
