# 0010: Apply remote updates into the open document, serialise writes per document

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0003](0003-full-document-set-sync.md) (decision 8, "one local
  write path" - it was one path but not a serialised one)

## Context

`DocumentRepository` was the single place document writes happened, which ADR
0003 established deliberately. It was not, however, a place where writes were
ordered, and the editor did not read from it at all.

**A peer's update took the long way round.** `mergeDelta` wrote the merged state
to SQLite and set `origin: 'remote'`, which made Rust emit `sync-received`. The
editor listened, compared the id against the open document, and fetched the
whole document back over IPC to apply it. Three full-document transfers per
remote edit, and a re-render of content the sync layer already held in memory.

Worse, `reloadCurrentDocument` read `current?.id` before the fetch and applied
the result to `ydoc` after it. Both are component state that a document switch
reassigns. Switching documents while that IPC call was in flight applied one
document's entire state into another document's `Y.Doc`. Both use the same
`content` fragment, so it merged cleanly, the next save persisted it, and the
delta fell back to the full snapshot (a remote-origin update is not in
`pendingUpdates`), so the corruption was broadcast to every peer as legitimate
CRDT content. A moment's bad timing corrupted a note permanently, everywhere.

**Writes to one document could interleave.** Writing is a read-modify-write:
load the stored state, merge, write the whole thing back. `save_yjs_update`
overwrites `crdt_state` outright. The data channel dispatches each inbound
message without awaiting the previous one (`void proto.handle(m)`), so a
`sync-delta` followed by a live edit for the same document already overlapped,
and with three devices two peers can write one document at once. Both writers
started from the same base and the later one silently dropped the other's
change. The convergence test harness awaits each `handle` serially, which is
exactly the serialisation the transport lacks, so nothing caught it.

**The editor saved for reasons that were not edits.** Tiptap's `onUpdate` fires
for the y-sync transaction too, so merging a peer's update scheduled a save.
That save had no recorded local delta, and `flushNow` fell back to broadcasting
the whole document, sending every peer's own edit straight back at it once per
remote keystroke batch.

## Decision

**1. The sync layer applies a peer's update into the editor's `Y.Doc`.**
`editor/openDocs.ts` holds a registry of open documents.
`DocumentRepository.openDocument()` reads the stored state and registers the
resulting `Y.Doc` as one queued operation; the editor unregisters before it
discards one. `mergeDelta` prefers the live copy: it is at least as advanced as
the stored state, and applying there is what puts the edit on screen. Nothing
is fetched back, and there is no id to get wrong because the merge never asks
what is currently open.

The invariant that makes this safe: **no `await` between `getOpenDoc()` and
`encodeStateAsUpdate()`**. Both Yjs calls are synchronous, so the editor cannot
tear the document down mid-merge. Everything asynchronous - hashing, the IPC
write - happens after the bytes are out.

**2. Writes are serialised per document** by a promise chain keyed on document
id, wrapping `mergeDelta` and `saveLocalUpdate`. Per document rather than
globally, because unrelated documents have no reason to queue behind each
other, and two writers of the _same_ document is the case that needs ordering.
A rejected write does not cancel the work queued behind it.

Queueing also closes two narrower holes. Opening a document reads its state and
registers it in one queued step, so a merge cannot land in the gap and leave
the editor showing content it would then save over. And a save folds its
snapshot into the live document before writing, because the editor encodes
synchronously and then queues, so a merge queued ahead of it is missing from
the snapshot.

**3. Live broadcast is strictly delta-based.** A null delta sends nothing.
`onContentChange` and the `autoSave` prop are removed; the only thing that
schedules a save is a Yjs update not tagged `REMOTE_ORIGIN`.

**4. `sync-received` survives as a notification.** It no longer carries any
obligation to fetch; the backlinks panel uses it to re-read derived rows.

## Alternatives considered

**Guard `reloadCurrentDocument` and keep the refetch.** Capture the `Y.Doc` and
the id before the await and bail if either changed. One line, and it does fix
the corruption. Rejected as the target: it keeps three full-document transfers
per remote edit, keeps the open document a special case in the sync layer that
ADR 0003 decision 1 was pleased to have removed, and leaves the echo. The guard
is still the right _shape_, and the registry is how it is expressed.

**Lock in Rust, around `save_yjs_update`.** The obvious place for a write lock.
Rejected: the critical section spans a Yjs merge that only TypeScript can
perform, so a lock held inside the command covers the write but not the read
the write is derived from.

**One global write queue.** Simpler than keying by id, and document writes are
not frequent. Rejected for the first pair with a large corpus, where phase 2
pulls documents four at a time and each would wait on the others for no reason.

**Have the editor own merging and let the sync layer hand it updates.** Closer
to how a collaborative editor is usually wired. Rejected because a document
that is not open still has to merge, so the repository needs the path anyway,
and having two would mean two orderings to reason about.

## Consequences

- A remote edit costs one write instead of three transfers plus a re-render,
  and appears in the open document without a reload.
- The editor no longer reads `document.crdt_state`, which was the field's only
  consumer. `Document` stops carrying it and `content_hash` over IPC, where
  both serialised as JSON number arrays at roughly 3.6 bytes per byte: opening
  a 1MB note moved several megabytes for nothing.
- Opening a document costs one `get_yjs_state` round trip that the bundled
  `crdt_state` used to save. This is deliberate: the bundled copy was whatever
  was fetched when the user clicked, which a merge since then may already have
  superseded.
- The no-await invariant is load-bearing and not enforced by the compiler. It
  is commented at both ends, and a test unregisters mid-flight.
- Skipping a live broadcast when there is no local delta means a peer can learn
  about a change slightly later than before, at the next manifest exchange.
  That is the guarantee ADR 0003 rests on; live messages are a latency
  optimisation on top of it.
