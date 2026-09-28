// Every editor's way of writing what it has not saved yet.
//
// Closing the window has to save the open note first, and the thing that
// handles closing is the layout (ADR 0030, decision 5), which has no editor of
// its own. Editors register here while they are mounted, and the layout flushes
// them all. Each flush returns null when there was nothing to write.

type Flush = () => Promise<void> | null;

const flushes = new Set<Flush>();

/** Register an editor's flush. Returns the function that unregisters it. */
export function registerPendingSave(flush: Flush): () => void {
    flushes.add(flush);
    return () => {
        flushes.delete(flush);
    };
}

/**
 * Write everything any editor has pending, and wait for it.
 *
 * A save that fails has already said so to the user (`persistSnapshot` shows a
 * toast), so one editor failing does not stop the others, and does not stop the
 * window closing.
 */
export async function flushPendingSaves(): Promise<void> {
    await Promise.allSettled([...flushes].map((flush) => flush() ?? Promise.resolve()));
}
