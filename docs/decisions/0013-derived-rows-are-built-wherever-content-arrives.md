# 0013: Build derived rows wherever content arrives, not only where it is typed

- **Status:** Accepted
- **Date:** 2026-09-14
- **Extends:** [0003](0003-full-document-set-sync.md)
- **Amends:** [0005](0005-attachment-sync.md) (the deferred reference scan)

## Context

Search text, outgoing links, task counts and attachment references are all read
by walking a rendered document. Only the editor could do that, so only a local
save produced them. Everything else was a gap:

- A document merged from a peer was stored with no index at all. It could not
  be found by search, contributed no backlinks, and reported no tasks, until
  the day someone happened to open and edit it on this device. For a corpus
  that mostly arrives by sync, that is most of it.
- A document that predates the index existing was never revisited either.
- Nothing recorded which attachments a document embeds, so
  `cleanup_orphaned_images` had nothing to check a blob against. It deleted
  rows with `is_fully_downloaded = 0` instead, which `store_attachment` never
  writes, so it collected nothing at all while reporting a count and showing a
  toast. An image removed from every note stayed on disk and kept being
  advertised to peers indefinitely.

ADR 0005 foresaw the last one and deferred it: "a reference scan can be added
later if bandwidth becomes a concern."

## Decision

**1. The sync layer renders a merged document and indexes it.** Yjs can be
converted to a ProseMirror document given a schema, so the index is built at
the moment content arrives rather than the moment someone looks at it.

**2. The schema is declared once, in `editor/extensions.ts`,** and shared by
the editor and the sync layer. It holds only what contributes a node or a
mark. The Yjs binding, the slash menu, the placeholder, the paste handlers and
the keyboard-aware scrolling stay with the editor: they contribute nothing to
the schema, and keeping them out is what lets the module be imported where
there is no DOM. Collaboration declares priority 1000, so lifting it out of
the middle of the editor's list does not change plugin order.

**3. The index is best-effort.** If the module cannot load, or the document
uses a node this build does not know, the merge still stores the content and
the document indexes when next opened. Indexing must never cost a merge.

**4. A document records the attachments it embeds,** in
`document_attachments`, replaced wholesale on every index exactly as
`document_links` is. Collecting an attachment then means what it always
claimed to: delete the blobs no live document refers to.

**5. Collection waits for a complete index.** `documents.index_version` marks
which documents have been through an indexer that records attachments, and
collection refuses to run while any live document with content is behind. A
startup backfill renders those documents headlessly and saves an index, which
also gives search, backlinks and counts to every document that predates them.

**6. The attachment manifest advertises only referenced blobs.** Otherwise a
peer that has collected an orphan pulls it straight back from us on the next
connect and collects it again, and two devices trade the same dead blob
forever.

## Alternatives considered

**Index only when a document is opened.** No new machinery, and the gap closes
for anything the user actually reads. Rejected: it makes search quietly
incomplete in a way nobody can see. A result that is missing looks exactly
like a result that does not exist.

**Move the CRDT into Rust with `yrs` and index there.** The tidiest separation,
and ADR 0003 drew the `DocumentRepository` boundary so it would stay possible.
Still rejected for the same reason: a second CRDT implementation that must stay
bit-compatible with the editor's.

**Declare a second, minimal schema for indexing.** Avoids sharing anything with
the editor. Rejected: it would have to be kept in step by hand, and would fail
by silently dropping the nodes it had not been told about, which is the failure
mode hardest to notice.

**Collect attachments by age, or on an explicit "clean up" button.** Avoids
needing reference data. Rejected: age says nothing about whether something is
in use, and a button that might delete a photo still on the page is not a
button worth having.

**Let both peers advertise everything and accept the re-download.** Simpler
than filtering the manifest. Rejected: it is not a one-off cost, it repeats on
every connection for the life of the pairing.

## Consequences

- Search covers the whole corpus, including documents this device has only
  ever received, and retroactively covers everything older than the feature.
- The first launch after this change does one render per unindexed document.
  It runs off the startup path and logs what it did; a large corpus will see a
  burst of writes once.
- The sync layer depends on the editor's schema module, deferred at the import
  so the two are not circular at load. That is a real coupling, accepted in
  preference to a second schema declaration.
- A document containing a node type this build does not know goes unindexed
  rather than failing to merge. That is the right way round, but it means an
  index can be silently incomplete after a downgrade; `index_version` is the
  lever for forcing a rebuild.
- Attachment collection is now destructive, where before it did nothing. The
  reference data and the unindexed gate are what stand between it and deleting
  a photo that is still on the page, so both are load-bearing.
