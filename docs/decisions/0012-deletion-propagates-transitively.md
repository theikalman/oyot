# 0012: A deletion is complete, and propagates through devices that never held the document

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0003](0003-full-document-set-sync.md) (decision 5, tombstones)
  and [0008](0008-deletion-as-last-writer-wins.md)

## Context

Two things about deletion were not what the earlier records said they were.

**The content survived.** ADR 0003 decision 5 says a delete "drops the CRDT
history like a local delete", and ADR 0008 says a revived journal "comes back
empty". Neither was true. Both delete paths called `delete_document_data`,
which clears `yjs_updates` and `yjs_snapshots` - tables nothing reads - and
left `crdt_state`, which is the only column content is ever loaded from. So a
deleted document kept all of it, and because a journal's id is derived from its
date and the next launch revives that row, deleting today's journal visibly did
not clear it. It also meant edits a tombstone was supposed to have beaten
reappeared intact on revival.

**A delete could not cross a device that never had the document.**
`reconcileEntry` dropped a tombstone for an unknown id, on the reasoning that
there is no row to mark. That holds for two devices and fails for three:

1. A creates D, B pulls it. A deletes D.
2. A meets C, which has never seen D. C drops the tombstone.
3. B meets C. C's manifest does not mention D at all, so B offers it as a
   document C is missing, and C pulls it back.

D flaps until all three have met since the delete, and if A is lost it never
settles: B and C keep handing it to each other forever.

## Decision

**1. Deleting clears `crdt_state` and `content_hash`**, in the same statement
as the tombstone, on both the local and the remote path. The remote path stays
gated on the tombstone winning the last-writer-wins comparison, so a stale
tombstone still takes nothing with it. Clearing the hash matters as much as the
content: a tombstone carrying a stale hash advertises content the device no
longer holds.

**2. A tombstone for an unknown document is recorded**, as a dead row with the
peer's lifecycle stamp. It gets no search row and does not appear in the
sidebar; it exists to be carried in the manifest, which is what lets the delete
continue to a third device.

**3. `delete_document` returns the stamp it wrote**, so the broadcast to peers
carries the same value the row does.

## Alternatives considered

**Keep dropping unknown tombstones, and prune the document set some other
way.** For instance, have the deleting device retain its tombstone forever and
rely on eventually meeting every peer. Rejected: it makes convergence depend on
a particular device staying alive, which is the property a device-to-device app
should not have. It is also exactly the "no central copy to fall back on"
problem ADR 0003 set out to solve.

**Hard-delete instead, and carry deletions in a separate log.** A tombstone is
a document row pretending to be something else, and a dedicated `deletions`
table would be tidier. Rejected as a larger change for the same result: the
manifest exchange already carries every row with its stamp, and a second
structure would need its own reconciliation.

**Clear the content only on the local delete, not the remote one.** Tempting,
because the remote path is the one that could in principle be wrong. Rejected:
it is gated on winning the stamp comparison, which is the same test that
decides whether the row is deleted at all. If that test is wrong, leaving the
bytes behind does not make it right.

**Leave `content_hash` set on a tombstone.** It costs nothing to keep and might
help identify what was deleted. Rejected: the manifest compares hashes to
decide whether to pull, and a hash for content this device cannot serve is a
lie a peer would act on.

## Consequences

- Deleting today's journal now genuinely clears it. That is what ADR 0008
  intended and described; the behaviour change is the code catching up.
- **Tombstones now accumulate on every device, not only on devices that held
  the document.** ADR 0003 already accepted unbounded tombstone growth and
  flagged pruning as future work; this makes the growth uniform across the
  set. A row is small, but the future task is now more clearly needed, and it
  has to be "pruned once every paired device has acknowledged it" rather than
  anything local.
- A first pair transfers the other device's tombstones as well as its
  documents. They carry no content, so the cost is one manifest entry each.
- Revival after a delete returns an empty document rather than the old
  content. For a journal that is the point. For a note deleted and recreated
  under the same id it is a real loss of content, but that only happens for
  date-derived ids, which is the case ADR 0008 built this around.
