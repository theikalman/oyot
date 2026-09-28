// The content hash, computed from a Yjs document the way crdt.rs computes it
// from a yrs one (ADR 0033). Test-only: in the app, Rust computes the hash.
// The interop test checks the two agree, and FakeRepo uses it so the sync
// protocol's tests compare documents the way real devices do.

import { createHash } from 'node:crypto';
import * as Y from 'yjs';

const DIGEST_TAG = new TextEncoder().encode('oyot-content-v1');

function u64(value: number): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
    return bytes;
}

function normalise(ranges: Array<[number, number]>): Array<[number, number]> {
    const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const joined: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
        const last = joined[joined.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else joined.push([start, end]);
    }
    return joined;
}

/** base64 of the content hash, or null while updates are pending. */
export function contentDigest(doc: Y.Doc): string | null {
    if (doc.store.pendingStructs || doc.store.pendingDs) return null;
    const hash = createHash('sha256');
    hash.update(DIGEST_TAG);

    const clocks = [...Y.decodeStateVector(Y.encodeStateVector(doc)).entries()]
        .filter(([, clock]) => clock > 0)
        .sort((a, b) => a[0] - b[0]);
    hash.update(u64(clocks.length));
    for (const [client, clock] of clocks) {
        hash.update(u64(client));
        hash.update(u64(clock));
    }

    const deleteSet = Y.createDeleteSetFromStructStore(doc.store);
    const deletions = [...deleteSet.clients.entries()]
        .map(
            ([client, items]) =>
                [client, normalise(items.map((i) => [i.clock, i.clock + i.len]))] as const,
        )
        .filter(([, ranges]) => ranges.length > 0)
        .sort((a, b) => a[0] - b[0]);
    hash.update(u64(deletions.length));
    for (const [client, ranges] of deletions) {
        hash.update(u64(client));
        hash.update(u64(ranges.length));
        for (const [start, end] of ranges) {
            hash.update(u64(start));
            hash.update(u64(end));
        }
    }
    return hash.digest('base64');
}

/** The content hash of a document's encoded state. */
export function stateDigest(state: Uint8Array): string | null {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return contentDigest(doc);
}
