# 0014: The merged blob is the only content store

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0003](0003-full-document-set-sync.md)

## Context

Document content lived in two places. `documents.crdt_state` holds the merged
Yjs state, written by `save_yjs_update` and read by `get_yjs_state`. Alongside
it, `yjs_updates` kept an append-only log and `yjs_snapshots` a periodic
consolidation of it, both written by the same call.

Nothing read either. `get_yjs_state` reads the column; `DbSnapshot::get_snapshot`
was marked dead code. The log's only live use was an `EXISTS` subquery
answering "does this document have content".

The cost was real. The editor's save path passes the whole merged state as the
"update", so every debounced save appended a second full copy of the document,
accumulating up to fifty before consolidation rewrote it a third time. On a
large note that is most of the write traffic in the app.

The same `EXISTS` check was also used to filter the sidebar, which is why a note
created with a title but never typed in vanished on the next launch. It stayed
in the database and kept syncing, but there was no way to open, rename or
delete it.

## Decision

Drop `yjs_updates` and `yjs_snapshots` in schema v5, and `db_snapshot.rs` with
them. `crdt_state` is the content.

`has_content` becomes `length(crdt_state) > 2`. An empty Yjs document encodes
to two bytes rather than zero, so it is a length test rather than a null test,
matching the constant the save path already checks before deciding a document
is worth writing at all.

The document list stops filtering on content. `has_content` is still reported,
because the journal calendar uses it to mark which days have an entry, but it
is not a reason to hide a row.

## Alternatives considered

**Make the log load-bearing: replay it on load and stop writing the merged
column.** This is the shape the log was presumably built for, and it would make
each save write only the delta. Rejected: it adds a transaction boundary and a
replay step to the read path to save writes on a path that is already debounced
and off the hot loop, and there is no requirement it satisfies that the merged
blob does not.

**Keep the tables, stop writing them.** Cheapest possible change. Rejected:
dead tables invite someone to start using one again, and the migration to drop
them later is the same migration as now.

**Keep the content filter and fix it another way**, for instance by hiding only
documents that have never been saved _and_ were not created locally. Rejected
as a rule nobody could predict from the outside. A document the user made
should be in the list.

## Consequences

- One write per save instead of two, and no periodic third. Storage stops
  growing with edit count for a given document.
- The update log is gone, so there is no per-edit history to build an undo or a
  document timeline on later. Yjs keeps its own history inside the merged state
  for the editor's undo stack, and anything richer would need a deliberate
  design rather than this log, which recorded whole snapshots and not edits.
- Empty documents appear in the sidebar. That is the fix, but it does mean a
  stray note created by a mistyped shortcut is now visible, which it was not
  before. It is also now deletable, which it was not before.
