import { getSchema } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { createContentExtensions } from './extensions';
import { extractDocumentIndex, type DocumentIndex } from './documentIndex';
import { CONTENT_FIELD } from './contentField';
import { NoteReader } from './noteBinding/NoteReader';

// Built once. Deriving a schema walks every extension, and this runs on the
// sync path where a first pair can merge hundreds of documents in a row.
let cached: Schema | null = null;

/**
 * The editor's schema, without an editor.
 *
 * Exported for the Markdown importer, which builds documents against it the
 * way this module reads them: there is one schema and one cache of it.
 */
export function contentSchema(): Schema {
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
    return extractDocumentIndex(rootFromYDoc(ydoc));
}

/**
 * The document itself, rendered against the editor's schema without an editor.
 *
 * Split out of `indexFromYDoc` for the exporter, which walks the same tree to
 * write Markdown. Both had to render a document nobody has opened, and there
 * is one schema and one cache of it to do that with.
 *
 * Read the way the editor reads it, and only read: `ydoc` can be the copy
 * behind the open editor, and is not changed whatever it holds.
 */
export function rootFromYDoc(ydoc: Y.Doc): ProseMirrorNode {
    return readNote(ydoc).root;
}

/** A note, and which element each of its nodes was read from. */
export interface ReadNote {
    root: ProseMirrorNode;
    /** Null for a node that stands for no one element, or is not in the note. */
    elementOf: (node: ProseMirrorNode) => Y.XmlElement | null;
}

export function readNote(ydoc: Y.Doc): ReadNote {
    const schema = contentSchema();
    const reader = new NoteReader(schema);
    const blocks = reader.blocks(ydoc.getXmlFragment(CONTENT_FIELD));
    return {
        root: schema.topNodeType.create(null, Fragment.from(blocks)),
        elementOf: (node) => {
            for (const [type, shown] of reader.mapping) {
                if (shown === node && type instanceof Y.XmlElement) return type;
            }
            return null;
        },
    };
}
