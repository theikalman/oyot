# 0027: Pin notes to the sidebar, and sync the pin like a title

- **Status:** Proposed
- **Date:** 2026-09-24
- **Extends:** [0003](0003-full-document-set-sync.md), [0008](0008-deletion-as-last-writer-wins.md), [0024](0024-back-up-the-crdt-and-import-by-merging.md)

## Context

The sidebar listed every note, newest first. That works at twenty notes and
not at two hundred: the list pushes the Index off the screen, and the notes in
use every day are somewhere in the middle of it. The request was for the
sidebar to hold only the notes the user chose, and for an index page, in the
shape of the journal and tag indexes, that lists all of them.

That leaves five things to decide: where a pin lives, whether it follows the
user to their other devices, how two devices that disagree about one settle
it, what the "+" beside the section does once the section only shows pinned
notes, and what updating looks like for someone whose sidebar was full of
notes the day before.

## Decision

**1. A pin is two columns on `documents`:** `pinned`, and `pinned_updated_at`
for when it was last set (schema v12). Not a derived row: a pin is not read out
of the content, it is the user's choice about the document, the same kind of
thing as its title. Nothing is backfilled, and no stamp means never pinned.

**2. It syncs, as a last-writer-wins register on `pinned_updated_at`,** the
shape the title (ADR 0003) and the lifecycle (ADR 0008) already have. The
manifest carries `pinned` and `pinnedUpdatedAt`, `reconcile()` adds `repin` to
its update decision, and `doc-pinned` is the live message beside
`doc-renamed`. Unpinning is stamped too, so it travels instead of losing to the
pin it undid.

**3. A tie goes to pinned,** in `reconcile()` and in `apply_remote_pin` alike.
Two devices only hold different pins at one stamp by setting them
independently, and without a rule for a tie each would keep its own for good.

**4. A pin set here is stamped no earlier than one past the stamp the row
holds.** That stamp may have come from a device whose clock runs ahead, and
the user's newest choice would otherwise be the older of the two and be undone
by the next exchange. Clock skew still decides between two devices acting
independently within it of each other, as ADR 0008 accepts for deletion.

**5. A new row takes the peer's pin, and only `apply_remote_pin` changes the
pin of a row that exists.** A document seen for the first time is inserted
pinned or not in one statement, and `doc-created` carries the pin, so a note
started as pinned never arrives unpinned and waiting on a second message,
which the protocol could handle before the first. A revived document keeps the
pin its row had, as it keeps its title, until the next exchange.

**6. Only notes are offered a pin.** A journal is reached by its day, through
the calendar and the journal index. The columns are on every document, and
the sidebar lists pinned notes only.

**7. The sidebar's Notes section becomes Pinned notes,** listing pinned notes
newest first, the order the section always used. Index > Notes opens a page
listing every note, with a filter, a pin toggle on each row, and Rename and
Delete, because the sidebar is no longer somewhere every note can be reached
from. An open note has a pin beside its title.

**8. A note started from the "+" beside Pinned notes starts pinned, and one
started from the Notes page does not.** What is added from a list lands in it.
The dialog shows the choice as a checkbox, so it is visible and can be changed
rather than being a rule to discover.

**9. Nothing is pinned after updating, and the empty section says where the
notes went,** with a link to the Notes page. Pinning every existing note would
rebuild the list this exists to shorten.

**10. Backups carry the pin, and an import merges it by the same rule.** Both
fields are left out of `documents.json` for a document nobody ever pinned, and
read as never pinned when absent. A library without pins backs up to the same
file and fingerprint as before, so updating does not cost an extra scheduled
backup. The format version stays 1: an older build reading a newer backup
skips the fields and loses the pins, and nothing else.

## Alternatives considered

**Pins on this device only,** in a local table or the webview's storage. No
wire change and nothing to reconcile. Rejected because everything else the
user decides about a note follows them, and a sidebar that differs between the
laptop and the phone would read as sync having failed. A per-device sidebar is
a defensible product; it is not what the rest of the app has taught the user
to expect.

**A `pins` table of its own.** Rejected: the manifest query and the backup
snapshot both read `documents`, and a side table is a second place to join and
a second place for some path to forget.

**A pinned list the user orders by hand.** Deferred: an order that merges
across devices needs more than a boolean per document, a position register or
a sequence CRDT. Newest first keeps each note where the old list had it.

**Pinning journals too.** Deferred. The section is for notes, and a day
already has a calendar cell.

**Keeping "+" for unpinned notes.** Rejected as a surprise: a note added from
the pinned list would not appear in it. Pinning without saying so was the
other way to surprise; the checkbox avoids both.

## Consequences

- A wire change with no negotiation (ADR 0007). Both fields are optional: an
  older peer ignores them and the new message, and its manifest reads here as
  never pinned, so it cannot unpin anything. A pin reaches a device once both
  run this build.
- Everyone starts with an empty Pinned notes section. That is deliberate
  (decision 9), and it will look like a regression for the first minute.
- Pin stamps are wall-clock milliseconds, like title stamps, with decision 4
  covering the common case of a device behind a stamp it has already seen.
- A deleted note's tombstone keeps its pin. Nothing lists a tombstone, and a
  note that comes back, comes back where it was.
- Deleting the note on screen falls back to the first pinned note rather than
  the first note, since that is the list the user is looking at.
