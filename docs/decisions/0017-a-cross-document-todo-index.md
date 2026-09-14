# 0017: A cross-document todo index, addressed by ordinal

- **Status:** Accepted
- **Date:** 2026-09-15
- **Extends:** [0013](0013-derived-rows-are-built-wherever-content-arrives.md)

## Context

Tasks were written down in whichever note or journal the user happened to be
in, and could only be read there. `document_index` held a count of a
document's task items, which is enough for a badge in the sidebar and no use
at all for the question people actually have, which is what is still
outstanding across everything they have written.

The count was the shape of the problem. Content lives in the CRDT, so anything
SQL can answer about it is whatever the indexer chose to record, and the
indexer recorded a number.

Two things then have to be decided: what a todo row looks like, and how a row
points back at the line it came from, given that a task item has no identity of
its own.

## Decision

**1. The indexer records each task item, not a tally of them.** Text, checked,
and nesting depth, in `document_todos`, replaced wholesale on every index pass
exactly as `document_links` and `document_attachments` are. It rides the walk
that was already counting them, on every path ADR 0013 established: a local
save, a merge from a peer, and the startup backfill. The counts in
`document_index` are now derived from the list, so a list and a count of it
cannot disagree.

**2. An item is addressed by its ordinal**: where it falls among the
document's task items, counted depth-first in document order. Replacing the
set on every index pass is what renumbers it.

**3. The two walks that have to agree live next to each other.**
`extractDocumentIndex` assigns the ordinals and `locateTaskItem` resolves them.
They are tested against the same nested fixtures, because a divergence would
put the cursor on the wrong line and look like nothing was wrong.

**4. The target rides in the URL**, as `/doc/<id>?todo=<ordinal>`. ADR 0015
made the URL the record of what is open; this makes it the record of where in
it. A link to a particular line stays a link, survives a reload, and the back
button undoes it.

**5. Journals are indexed alongside notes.** A day's tasks usually land in that
day's journal, and a list of what is outstanding that quietly left them out
would be worse than no list. They are shown in their own section, in date
order, because a journal is read by its day and a note by its name.

**6. The page is a reader, not an editor.** It opens notes; it does not change
them. Ticking a box here would mean writing into the CRDT of a document
nothing has open, which is a different piece of work with its own conflict
questions.

## Alternatives considered

**Give each task item an id attribute.** The obvious answer, and the one an
ordinal is working around. Rejected on cost: it changes the schema, it needs a
CRDT write on every existing document just to stamp ids, and two devices that
both open an unstamped document mint different ids for the same item and then
have to reconcile them. An ordinal needs no writes, no schema change and no
reconciliation, and the thing it buys in exchange, stability across edits, is
worth less here than it looks: the rows are rebuilt on every edit anyway.

**Store the ProseMirror position.** The same cost as an ordinal and strictly
more fragile: a position moves when anything earlier in the document changes,
including text that has nothing to do with any task item.

**Carry the item's text in the URL as a checksum**, so a stale ordinal could be
detected and corrected. Rejected: it makes the URL as long as the todo, and it
is wrong as often as it is right. An item whose text was edited on another
device would fail the check and send the user nowhere, when the ordinal would
have taken them to the right line. The exposure it closes is one document
changing between the page being read and a row being clicked, which costs a
cursor on a neighbouring line.

**Query the documents at read time** rather than keeping rows, rendering each
one headlessly when the page opens. No new table and nothing to keep in step.
Rejected: it puts a render of the entire corpus in front of a page the user
will open many times a day, to recompute something that only changes when a
document is written.

**Put todos in the FTS table.** It already holds body text. Rejected: it has no
ordering to rely on and no place for `checked` or `depth`, and search results
and task items are not the same thing.

## Consequences

- `INDEX_VERSION` is bumped, so the first launch after this change re-renders
  every document with content. That is what gives the page todos written
  before it existed. Attachment collection stays gated off until the backfill
  finishes, as it is after any bump.
- A view that reads derived rows now has to be told when they change, which is
  what `stores/derivedIndex` is for. The todo page is the first view whose
  contents are changed by something happening on a different route, or on
  another device entirely.
- An ordinal is only as current as the rows the page is showing. A document
  changed between the page loading and a row being clicked can put the cursor
  on a neighbouring item, or on nothing, in which case the note still opens and
  a toast says why. The rows reload on every change, so the window is small.
- The sidebar badge is summed from counts the document store already keeps
  current, so it costs no query, and it is only as right as those counts are.
- A document containing a node type this build does not know goes unindexed
  and contributes no todos, the same best-effort rule ADR 0013 accepts for
  search and backlinks.
