import { writable } from 'svelte/store';

/**
 * Bumped whenever a document's derived rows change: its todos, its links, its
 * searchable text.
 *
 * Views built on those rows read SQL, not the CRDT, so nothing tells them
 * when the answer has moved. The todo index is the case that forced this:
 * it lists every document, and the thing that changes one of them is usually
 * somewhere else entirely, either the editor on another route or a peer's
 * edit arriving while the page is open.
 *
 * A counter rather than the rows themselves. What changed is not worth
 * modelling: the queries are cheap, the corpus is one person's notes, and a
 * store that tried to patch rows in place would be a second copy of the
 * indexer's rules, kept in step by hand.
 */
export const indexRevision = writable(0);

export function bumpIndexRevision(): void {
    indexRevision.update((n) => n + 1);
}
