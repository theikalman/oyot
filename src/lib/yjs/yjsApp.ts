import * as Y from 'yjs';

/**
 * Create a fresh, empty Yjs document.
 */
export function createYjsDoc(): Y.Doc {
    return new Y.Doc();
}

/**
 * Hydrate a Yjs document from an ordered array of raw update blobs.
 * Blobs come from `load_document_ledger` (Rust → JS as number[][]).
 */
export function loadYjsDocFromUpdates(updates: Uint8Array[]): Y.Doc {
    const ydoc = new Y.Doc();
    for (const update of updates) {
        Y.applyUpdate(ydoc, update);
    }
    return ydoc;
}

/**
 * Encode the current full state of a Yjs document as a single update blob.
 * Useful for seeding the initial state when creating a new document.
 */
export function encodeYjsState(ydoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(ydoc);
}
