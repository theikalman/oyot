# 0039: Put pinned notes in order by hand, with a position in the pin

- **Status:** Proposed
- **Date:** 2026-11-04
- **Extends:** [0027](0027-pin-notes-to-the-sidebar-and-sync-the-pin.md)

## Context

The sidebar lists pinned notes newest first, which says when a note was made
and nothing about how much it matters. The request was to put them in order by
hand, with a mouse, on a tablet and on a phone.

ADR 0027 deferred this, because "an order that merges across devices needs
more than a boolean per document, a position register or a sequence CRDT." The
order has to follow the user for the reason the pin does: a sidebar that
differs between the laptop and the phone reads as sync having failed. So there
are four things to decide: what an order is, how it syncs, where a new pin
goes, and how a finger picks up a row in a list that also scrolls.

## Decision

**1. A note's place is a `pin_position` column on `documents`** (schema v16), a
string of digits read as the fraction after a decimal point. Positions sort as
plain strings, and there is always another between any two, so a move usually
writes the note that moved and none of its neighbours.

**2. The position is part of the pin.** It is one register with `pinned`, under
the same `pinned_updated_at` stamp, so it needs no new stamp and no new message.
The manifest gains `pinPosition`, `doc-pinned` carries it, `reconcile()` decides
with the `repin` it already has, and a move is stamped by the rule of ADR 0027,
decision 4. Each note's place is its own register, so a note moved here and
another moved on a phone both survive the next exchange. Two moves of one note
go to the later stamp.

**3. At a tie on the stamp, pinned wins as before, and then the later position,
with any position beating none.** Without a rule two devices that moved a note
in the same millisecond would keep their own for good. Positions are compared
as bytes, in `apply_pin_if_newer` and in `reconcile()` alike, so the two cannot
settle on different answers.

**4. A note with no position sits above every note with one, newest first.**
That is the whole of where a new pin goes: nothing that pins a note has to work
out a place, including `create_document` and a peer's `doc-created`. It also
means the list looks as it always did until the first move, and nothing is
backfilled. Pinning or unpinning clears the position, so a note pinned again
starts at the top.

**5. The frontend works positions out, and Rust stores them unread.** The
frontend holds the list, and the rule is a pure function beside the note index.
`set_pin_positions` writes a move in one transaction. A move usually writes one
note. It writes more only when notes below where it lands cannot stay as they
are: unplaced notes always sort above placed ones, so a move above some of them
has to place them too, and two notes that took one position have nothing
between them.

**6. Dragging is built on pointer and touch events, not HTML5 drag and drop,**
which touch screens do not have. A mouse lifts a row by moving it 4px. A finger
has to rest on the row for 400ms first, because a finger moving on a list is a
scroll, and most of a sidebar on a phone is rows. A row stays where it is in the
page until the drop and is only moved by a transform, so nothing has to survive
a re-render in the middle of a gesture. The list scrolls by itself near the edge
of the sidebar, by the clock rather than by the frame, so a 120Hz tablet scrolls
no faster than a 60Hz laptop.

**7. A note's menu in the sidebar has Move up and Move down.** Dragging is no
use from a keyboard, or to anyone who cannot hold and drag.

**8. The store moves first and the write follows,** the other way round from
every other document action, and goes back if the write fails. A row is let go
where it is meant to stay, and waiting on the write would show it in its old
place for a moment.

**9. Backups carry the position, and an import merges it by the same rule.** It
is left out of `documents.json` for a note nobody placed, so a library that was
never put in order backs up to the same file and fingerprint as before.

## Alternatives considered

**One ordered list of ids, as a single register.** The simplest thing to
display, but a move on one device would overwrite a move on another, however
unrelated. It would also need a new message and a new place in the manifest,
which is built around one entry per document.

**A sequence CRDT.** Merges concurrent moves exactly, and is a lot of machinery
for a short list the user edits by hand. Under decision 2 the worst outcome is
that two moves of one note keep the later.

**A number for the position.** Halving a gap in a double runs out after about
fifty moves into one place, and then every position has to be rewritten, which
is the multi-device problem this exists to avoid. Digits do not run out.

**Deriving a position from `created_at`, so that a move never has to place
other notes.** Then a new note's place depends on how a moved note's position
compares with the clock, and a note moved to the top could stay above notes
made after it.

**A visible drag handle on each row.** Would need no hold, at the cost of width
in a 264px sidebar and a control on every row of a list that is mostly read. The
hold is how phones lift things anyway, and the menu is there to be found.

**A new pin at the bottom.** Then pinning a note in a long list gives no sign it
worked, and a new pin would land in the opposite place from the newest-first
list everyone is used to.

## Consequences

- A wire change with no negotiation (ADR 0007). Both new fields are optional,
  so an older peer ignores the position and keeps the stamp. It comes back with
  that stamp and no position, which decision 3 reads as losing, so it cannot
  undo a move. A note re-pinned on an older build arrives with a newer stamp and
  no position, and goes to the top.
- Moves between devices reach each other as last-writer-wins per note, not as a
  merge of intent: two devices each moving a different note can leave them in an
  order neither device showed. Every device still ends up with the same list.
- A position grows by about a digit every few moves into one gap. A list ordered
  by hand stays short enough that this is not worth rebalancing for.
- The first move in a list nobody has ordered can write several notes, since it
  has to place the ones below where it lands.
- The pinned cards on a phone's Notes page show this order, and cannot change
  it. The drawer on the same phone can.
