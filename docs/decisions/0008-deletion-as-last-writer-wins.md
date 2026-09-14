# 0008: Make deletion a last-writer-wins register

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0003](0003-full-document-set-sync.md) decision 5 ("Tombstones
  always win")
- **Amended by:** [0012](0012-deletion-propagates-transitively.md)

## Context

ADR 0003 settled deletion with a simple rule: a tombstone beats a live document,
on the reasoning that resurrecting something the user deleted is worse than
losing a late edit. `reconcileEntry` implemented it by branching on `isDeleted`
alone.

That rule cannot express "I recreated this after you deleted it", and journals
need exactly that. A journal's id is derived from its date
(`format_journal_date`), deliberately, so two devices that both write Tuesday's
entry converge on one row instead of two. But deletes are soft, so the tombstone
keeps the id. Three things followed:

1. `get_or_create_today_journal` did a plain `INSERT` after a `SELECT ... WHERE
is_deleted = 0` miss, so deleting today's journal made it fail with
   `UNIQUE constraint failed: documents.id`. Startup awaits that call before it
   can open a document, so the editor pane sat on "Loading..." on every launch
   from then on.
2. Clicking any previously-deleted date in the calendar silently did nothing,
   for the same reason.
3. Even with the insert fixed to revive the row, the revival did not survive:
   the peer still held `is_deleted = 1`, and the next manifest exchange applied
   its tombstone and deleted the journal again.

Point 3 is the one that needed a protocol decision. Points 1 and 2 are just the
`INSERT` needing to be an upsert.

## Decision

Deletion becomes a last-writer-wins register, the same shape the title already
had via `title_updated_at`.

1. **`lifecycle_updated_at` on `documents`** (schema v2) records when this
   device last observed `is_deleted` change, in either direction. Delete stamps
   it, revival stamps it.
2. **The manifest carries `lifecycleUpdatedAt`.** Reconciliation compares
   stamps instead of branching on the flag: the later observation wins, whether
   it is a tombstone or a revival.
3. **Creating a document upserts.** `ON CONFLICT(id) DO UPDATE` clears the
   tombstone and stamps the revival, so a date-derived id can be reused.
4. **`ensure_document` can clear a tombstone**, gated on the peer's stamp being
   newer, so a `doc-created` broadcast doubles as the revival signal.
5. **`apply_remote_delete` returns whether it applied**, and only drops the CRDT
   history when it did. Dropping it unconditionally emptied a document whose
   revival had already been accepted, leaving a live but blank row.

The field is optional on the wire. A peer on an older build omits it and
`lifecycleStamp()` falls back through `deletedAt`, `titleUpdatedAt`,
`createdAt`. Consistent with [ADR 0007](0007-drop-protocol-version.md), there is
no version negotiation: the fallback exists so a mid-update pair still orders
sensibly, not as a compatibility contract.

## Alternatives considered

**Keep "tombstones always win", give a revived journal a fresh id.** Something
like `14 Sep 2026#2`. This breaks the property that makes date-derived ids worth
having: two devices creating the same day's journal offline would no longer
converge on one row. Rejected.

**Hard-delete journals so the id is free.** The row is what propagates the
delete to peers; removing it means the delete never reaches them, and the
document returns on the next sync. Rejected.

**Revive without a stamp.** The minimal fix for the crash, and what the first
pass did. It leaves the two devices permanently disagreeing: the reviver shows
the journal, the peer re-deletes it on every exchange. Rejected, and it is the
reason this ADR exists rather than a one-line patch.

## Consequences

- **Deleting today's journal now reads as "clear it".** `+page.svelte` calls
  `ensureTodayJournal()` on every launch, so today's entry comes back empty.
  That is the right behaviour for a journal, but it is a behaviour change:
  previously the delete appeared to stick, because the app was broken.
- **Clock skew decides close races.** The stamps are wall-clock milliseconds
  from whichever device acted, with no shared clock. A delete and a revival less
  than the skew apart can settle either way. Same exposure `title_updated_at`
  already had, and the same reason: a Lamport clock would need a peer-visible
  counter per document, which is more machinery than the failure justifies.
- **Startup no longer depends on the journal.** Opening today's entry is now
  wrapped separately in `+page.svelte`, falling back to the first document, so a
  future failure here degrades instead of blanking the editor.
- **One more stamp to carry.** Every create, delete and manifest entry now has
  to set `lifecycle_updated_at`. A path that forgets it silently reverts to the
  old behaviour for that document, since the fallback treats a missing stamp as
  `createdAt`.
