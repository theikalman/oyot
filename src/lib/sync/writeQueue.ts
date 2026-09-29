// Serialises asynchronous work by key, so two operations on the same key never
// interleave while operations on different keys still run in parallel.
//
// The sync layer used this to keep writes to one document from losing each
// other, when `save_yjs_update` overwrote `crdt_state` with whatever the page
// had merged. Rust merges now (ADR 0031, decision 3), and the queue keeps the
// page's own steps around a write in order: opening a document reads and
// registers it in one step, a peer's update is applied to the open copy only
// once it is registered, and an index is read from the copy it describes.
//
// That is routine rather than exotic: Rust's events arrive without waiting
// for the page to finish with the last one, so two peers' updates to the
// document being opened are already concurrent with the opening.
export type WriteQueue = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function createWriteQueue(): WriteQueue {
    // The tail of each key's chain. Absent means nothing is in flight.
    const tails = new Map<string, Promise<unknown>>();

    return function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = tails.get(key) ?? Promise.resolve();

        // `then(work, work)` rather than `then(work)`: a rejected predecessor
        // must not cancel the work queued behind it. One failed write should
        // cost that write, not every later write to the same document.
        const result = previous.then(work, work);

        // The chain tracks completion, not success, so a rejection does not
        // poison the queue. The caller still sees the rejection through
        // `result`.
        const link: Promise<unknown> = result.catch(() => undefined);
        tails.set(key, link);

        void link.then(() => {
            // Only the newest link may clear the slot. An older one settling
            // late would drop a chain that still has work queued behind it.
            if (tails.get(key) === link) tails.delete(key);
        });

        return result;
    };
}
