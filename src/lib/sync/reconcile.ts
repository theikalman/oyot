import { lifecycleStamp, pinStamp, type ManifestEntry } from './protocol';

/**
 * What to do about one document, given how another copy of the library
 * describes it and how this device holds it.
 *
 * These are the rules of whole-set reconciliation (ADR 0003), with deletion
 * as a last-writer-wins register (ADR 0008). They are pure, and they live
 * here rather than inside the sync protocol because two things merge another
 * copy of the library into this one: a peer's manifest, and a backup being
 * imported (ADR 0024). Both decide by this function, so the two cannot drift
 * apart.
 */
export type Reconciliation =
    /** They deleted a document this device never held: record the tombstone. */
    | { kind: 'record-tombstone' }
    /** They deleted it after this device last saw it change: delete it here. */
    | { kind: 'delete'; deletedAt: number }
    /** Their tombstone is older than what this device has seen since. */
    | { kind: 'stale-tombstone' }
    /** A document this device has never seen: create it and take its content. */
    | { kind: 'create' }
    /** They revived it after this device deleted it: revive it and take its content. */
    | { kind: 'revive' }
    /** This device deleted it at least as late as they last changed it. */
    | { kind: 'stays-deleted' }
    /** Both hold it: take a newer title or pin, and exchange content if it differs. */
    | { kind: 'update'; rename: boolean; repin: boolean; pull: boolean }
    /** Both hold it, the same. */
    | { kind: 'up-to-date' };

export function reconcile(remote: ManifestEntry, local: ManifestEntry | undefined): Reconciliation {
    // `isDeleted` is a last-writer-wins register keyed on the lifecycle stamp,
    // the same shape the title already uses. Branching on the flag alone
    // could not express "I revived this after you deleted it", so a revived
    // journal was re-deleted on the next manifest exchange.
    const remoteStamp = lifecycleStamp(remote);
    const localStamp = local ? lifecycleStamp(local) : -1;

    if (remote.isDeleted) {
        // Record it rather than dropping it. Dropping is what stopped a delete
        // propagating past the first device that never held the document:
        // nothing to mark, so nothing to advertise onward, and a third device
        // that still has the document hands it straight back on the next
        // exchange.
        if (!local) return { kind: 'record-tombstone' };
        if (remoteStamp > localStamp) {
            return { kind: 'delete', deletedAt: remote.deletedAt ?? remoteStamp };
        }
        return { kind: 'stale-tombstone' };
    }

    if (!local) return { kind: 'create' };

    // This device holds a tombstone they do not. Ours wins only if we observed
    // it at least as late; otherwise they revived the document after our
    // delete, so the revival is accepted and its content taken.
    if (local.isDeleted) {
        return localStamp >= remoteStamp ? { kind: 'stays-deleted' } : { kind: 'revive' };
    }

    const rename = remote.titleUpdatedAt > local.titleUpdatedAt;
    const repin = pinWins(remote, local);
    // A missing hash is an unknown, not a match: exchange rather than assume.
    const pull =
        !local.contentHash || !remote.contentHash || local.contentHash !== remote.contentHash;
    return rename || repin || pull
        ? { kind: 'update', rename, repin, pull }
        : { kind: 'up-to-date' };
}

/**
 * Whether their pin is the later word on a document both sides hold.
 *
 * A tie goes to pinned. Two devices hold different pins at one stamp only by
 * setting them independently, and with no rule for a tie each would keep its
 * own for good. `apply_remote_pin` breaks it the same way, so a manifest
 * exchange and a live message cannot settle on different answers (ADR 0027).
 */
function pinWins(remote: ManifestEntry, local: ManifestEntry): boolean {
    const theirs = pinStamp(remote);
    const ours = pinStamp(local);
    if (theirs !== ours) return theirs > ours;
    return (remote.pinned ?? false) && !(local.pinned ?? false);
}
