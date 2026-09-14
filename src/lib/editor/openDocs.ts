import type * as Y from 'yjs';

// The Y.Doc behind the open editor, for as long as a document is open.
//
// The sync layer consults this so a peer's update can be applied to the
// document the user is looking at. The alternative -- write the merge to
// SQLite, emit an event, have the editor fetch the whole document back and
// apply it -- was both slow (three full-document IPC transfers per remote
// edit) and unsafe: it re-read "the current document" after an await, so
// switching documents mid-flight applied one document's state to another
// document's Y.Doc, then persisted and broadcast the result as legitimate
// content.
//
// Ownership: `DocumentRepository.openDocument` registers, the editor
// unregisters when it tears the document down.
const openDocs = new Map<string, Y.Doc>();

export function registerOpenDoc(docId: string, doc: Y.Doc): void {
    openDocs.set(docId, doc);
}

// Takes the Y.Doc as well as the id so a late unregister from an editor that
// has already been replaced cannot evict its successor's registration, which
// a fast switch away from a document and back would otherwise do.
export function unregisterOpenDoc(docId: string, doc: Y.Doc): void {
    if (openDocs.get(docId) === doc) openDocs.delete(docId);
}

// The live copy, or undefined when the document is not open.
//
// Callers must not await between this lookup and the Yjs work they do with the
// result. Both `applyUpdate` and `encodeStateAsUpdate` are synchronous, so
// holding to that rule is what makes it impossible for the editor to tear the
// document down underneath an in-flight merge.
export function getOpenDoc(docId: string): Y.Doc | undefined {
    return openDocs.get(docId);
}
