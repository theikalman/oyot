# 0020: Renaming a tag edits every note that carries it, one attribute at a time

- **Status:** Accepted
- **Date:** 2026-09-21
- **Extends:** [0019](0019-tags-as-inline-nodes-with-one-spelling.md)
- **Amends:** [0017](0017-a-cross-document-todo-index.md) (an index page is a reader)

## Context

ADR 0019 decided there is no tag registry: a tag exists because documents carry
chips saying so, and those chips are the only record. That is what makes a tag
free to create and impossible to leave lying around, and it is also what makes
renaming one hard. There is no row to update. The name is written into every
note that uses it, and most of those notes are not open.

ADR 0017 drew the line at exactly this point and left it there. The todo index
is a reader, "it opens notes; it does not change them", because ticking a box
would mean writing into the CRDT of a document nothing has open, "a different
piece of work with its own conflict questions". A tag index that can rename is
that piece of work.

Deleting a tag raises none of it, because there is nothing to delete: a tag is
gone when the last chip spelling it is.

## Decision

**1. A rename is an edit to every document carrying the tag.** There is nowhere
else for it to happen. `renameTag` reads the documents from `document_tags`,
then rewrites each one, and each rewrite is saved, re-indexed and broadcast as
the ordinary local edit it is.

**2. The edit sets one attribute in the CRDT.** It does not render the document
to ProseMirror, change it and write it back. Re-serialising replaces every node
in the document, which to a peer reads as "the whole note was rewritten": a
concurrent edit anywhere in it loses to the replacement, and the update is the
size of the note rather than the size of the change. Yjs settles two devices
renaming the same chip the way it settles any attribute, by taking the later
one, and a rename made beside someone else's edit to the next paragraph keeps
both.

**3. Each document is rewritten through the repository's write queue**, like
every other write to a document. A rename is a read-modify-write over the column
`save_yjs_update` overwrites outright, so two of them at once, or one beside a
peer's delta arriving, would lose an edit.

**4. A document that is open belongs to the editor.** The rename goes into the
live `Y.Doc`, and nothing else: the editor's update listener already saves the
result and broadcasts it, and sending it from the rename as well would echo the
same edit at every peer. The repository reports the two cases apart, by handing
back an update to broadcast only when there is one to send.

**5. A rename is not atomic, and says so.** The documents are separate CRDTs
with separate peers; there is no transaction that spans them. A failure part way
through leaves some notes renamed and some not, so the count of what failed is
reported rather than swallowed, and running it again finishes the job, because
renaming what is already renamed changes nothing.

**6. Renaming onto a tag that already exists merges the two.** That is what
people want the operation for, more often than not. The dialog says it will
happen before it does. A note that carried both ends up showing the chip twice;
the index counts it once, because a document carries a tag or it does not.

**7. There is no delete, and the page says why.** A button that removed a tag
would have to strip chips out of the user's sentences, which is an edit to their
writing rather than to a label. Removing the chip is how a tag is removed, and
it already works.

## Alternatives considered

**Give tags a registry table and rename the row.** One write, atomic, instant.
Rejected for the reason ADR 0019 rejected a registry in the first place: the
chips in the notes and the rows in the table would be free to disagree, and
nothing could tell which was right. It would also do nothing for peers, whose
notes still spell the tag the old way.

**Rename in SQL only, and leave the documents alone.** Cheaper still, and the
tag pages would look correct immediately. Rejected because it is a lie that
lasts exactly until the next index pass: the rows are derived from content, so
the first save of any renamed note would put the old tag back.

**Render each document, rewrite it and save it.** The obvious implementation,
and it reuses machinery that exists. Rejected on what it costs a peer, in
decision 2: it turns a one-attribute change into a whole-document rewrite that
silently wins every concurrent edit.

**Do it in Rust, over the stored blobs.** It is a bulk operation over documents
nobody is looking at, which is the shape of thing that belongs in the backend.
Rejected for the reason ADR 0013 gives for not moving the CRDT into Rust: it
needs a second Yjs implementation that stays bit-compatible with the editor's,
and this would be the first thing to write through it rather than merely read.

**Refuse to rename onto an existing tag.** Avoids the duplicate chip in decision
6, and avoids a rename that quietly merges two things. Rejected: merging tags is
a thing people genuinely want, refusing it leaves them doing it by hand in every
note, and the dialog can simply say what will happen.

**Run it in the background with a progress bar.** A corpus large enough to need
one is a corpus where this matters. Deferred: one person's notes are not that
corpus, the work is one small write per note, and a dialog that reports what it
did is easier to trust than one that leaves.

## Consequences

- Renaming a tag writes to every note that carries it, which bumps each note's
  `updated_at` and sends each peer an update. A tag on fifty notes is fifty
  small writes and fifty small messages.
- A device that is offline learns about the rename when it next syncs, like any
  other edit. Until then it spells the tag the old way, and its own tag page
  says so.
- A rename interrupted part way leaves the corpus holding both names. Both
  appear in the tag index, which is the honest picture, and renaming the old one
  again finishes the job.
- Two devices renaming the same tag to different things converge on one of them,
  chip by chip. A note can therefore end up with chips spelling it both ways
  until one more rename settles it.
- The tag index is the first page in the app that changes documents rather than
  only opening them, which is the line ADR 0017 declined to cross. What makes it
  acceptable here is that the edit is one attribute with a known position, not a
  new piece of content that has to be merged into a document's structure.
