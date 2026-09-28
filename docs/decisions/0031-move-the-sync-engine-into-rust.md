# 0031: Move the sync engine into Rust, and make the webview its client

- **Status:** Proposed
- **Date:** 2026-09-28
- **Supersedes:** [0003](0003-full-document-set-sync.md) decision 3 ("CRDT
  diffing stays in TypeScript")
- **Amends:** [0010](0010-apply-remote-updates-into-the-open-document.md)
  (who merges, and how an update reaches the open document),
  [0013](0013-derived-rows-are-built-wherever-content-arrives.md) decision 1
  (when a merged document is indexed)
- **Extends:** [0003](0003-full-document-set-sync.md),
  [0014](0014-the-merged-blob-is-the-only-content-store.md)

## Context

Everything that syncs a document runs in the webview:

- the connection (`transport.ts`)
- the manifest and delta protocol (`DocSyncProtocol.ts`)
- the reconcile rules (`reconcile.ts`)
- the Yjs work of diffing, merging, hashing and indexing
  (`DocumentRepository.ts`)

Rust stores the bytes it is handed. Even the Rust listener, discovery and
prober are started and stopped by the page, from `initSync` and `shutdownSync`
in `+layout.svelte`.

That is why nothing syncs in the background. Most platforms slow or suspend a
webview whose window is hidden; Windows is spared only by a quirk of the
current Tauri (ADR 0030). A phone's background work is worse off:

- **Android.** WorkManager starts the process without the Activity, and Tauri
  only starts from the Activity.
- **iOS.** A background task does launch the whole app, Tauri and its window
  included. But nothing promises the page any time to run then (Capacitor, for
  one, documents that its webview is not available), and under the scene life
  cycle, which Apple makes mandatory after iOS 26, no window is created in the
  background at all.

A headless JavaScript engine does not help either: it has no DOM, no WebRTC
and no Tauri bridge.

ADR 0003 weighed moving the CRDT work into Rust with `yrs` and rejected it as
too large for that change, but drew the `DocumentRepository` boundary so the
move would stay localised. Background sync is the reason to make it now.

Two facts about how documents are stored shape the design:

- `save_yjs_update` overwrites `crdt_state` with whatever merged state the
  webview computed. With two writers, each would silently erase the other's
  updates.
- A merged document is indexed by rendering it against the editor's schema
  (`headlessIndex.ts`), and only the webview can do that.

## Decision

**1. Rust owns sync, for the whole life of the process.** A `sync` module
holds:

- the connection manager (ADR 0032)
- the manifest and delta protocol
- the reconcile rules
- the merge

It starts from `setup()` once the identity is loaded, or from a phone's
background entry point (ADR 0034), whichever comes first, and stops only when
the process exits. The page no longer starts or stops anything, so hiding,
reloading or destroying the window leaves sync alone.

The core is always in one of three modes:

- **Foreground.** Listening, advertising, discovering, and holding a
  connection to every paired device it can reach. A desktop is always in this
  mode, window or not.
- **Dial-out run.** A bounded run on a phone in the background (ADR 0034). It
  dials, syncs and stops, and never listens.
- **Idle.** A phone in the background between runs. Nothing is open.

A phone moves between them with the platform's own life cycle (ADR 0034,
decision 1), not with its windows.

**2. The protocol is ported, not redesigned.** All of it carries over unchanged
apart from the transport (ADR 0032) and one addition:

- the two phases and the live messages
- the attachment exchange
- the in-flight limits (four document pulls, two images)
- the timeouts and retry counts
- the rule that every `sync-need` gets an answer (ADR 0006)
- the reconcile rules, the pin tie included (ADR 0027)

The addition fixes when a connection counts as synced. Today a side reports
synced once its own pulls settle and the other side has sent `sync-done`. But
the other side sends `sync-done` once it has decided what to pull and asked
for the first few, not once it has them all. So one side can report synced
while the other is still pulling from it. That is harmless while connections
stay open, and wrong for a background run that stops when it is synced (ADR
0034). Each side now also sends `sync-complete` when its own pulls have all
settled, and a connection counts as synced only when both sides have sent it.

The tests that pinned these down come with them. `reconcile.test.ts`,
`DocSyncProtocol.test.ts`, `writeQueue.test.ts` and
`DocumentRepository.test.ts` are rewritten as Rust tests, case by case, before
the TypeScript goes.

**3. Merging uses `yrs`, and the stored state is only ever merged into.**
Writes to one document are serialised in Rust, as `writeQueue.ts` serialises
them now. `save_yjs_update` becomes a merge: it applies the incoming update to
the stored state instead of replacing it. With Rust and the editor both
writing, replacing loses whichever update landed first. Merging cannot lose
either, since applying an update twice changes nothing.

**4. The editor sends what the store is missing.** The open document stays a
`Y.Doc` in the webview, since that is what Tiptap edits. On save, the editor
sends `Y.encodeStateAsUpdate(doc, storedStateVector)`, where the state vector
is the one Rust returned from the previous write, along with the index it
extracted (decision 7). Rust merges it, stores the index, and sends the delta
to connected devices. A save that failed or went missing is folded into the
next one, because each delta is computed against what the store says it
holds, not against the last thing the editor sent.

**5. Merges reach the open document as events.** Whatever Rust merges from a
peer, it sends to the page as an event carrying what the merge added. The page
applies it to the open copy, if there is one, with `REMOTE_ORIGIN`, so the
editor does not save it again. Everything else that changes a document (a
save, an import, a tag rename) starts in the page, which applies it to the
open copy itself.

The page keeps the order. Every step it takes on one document runs in turn,
through `writeQueue.ts`, and an event is handled as one of those steps:

- **Opening a document** reads its state and registers the open copy in one
  step. An update Rust merged after the read arrives as an event queued behind
  it, and finds the copy registered. One merged before the read is already in
  what was read.
- **The save from an editor being closed** is queued ahead of the open from
  the editor replacing it, so the new editor opens on it.

Registrations kept in Rust, one per open document, would do the same ordering
there. With one page and one editor per document, the queue already does it,
so they were left out.

**6. Every other write goes through Rust too.** These all end in a Rust command
that also tells connected devices:

- creating, renaming, pinning and deleting a document
- saving an image
- renaming a tag across notes
- importing notes or a backup

So the `broadcast*` functions leave the page's surface, along with `save_pair`
and `update_pair_sync_time`. Rust records pairings itself (ADR 0032, decision
5).

**7. Indexing stays in the webview, and catches up.** A document Rust merges is
written with `index_version = 0`, and Rust emits `doc-merged`:

- **A page is running, and the document is closed.** The page renders it with
  the existing headless path and saves the index through a new command. That
  command ignores the index if the document has changed since the page read
  it. It checks by content hash (ADR 0033), not by state vector, since a
  deletion leaves the state vector as it was.
- **The document is open.** The page indexes the editor's own copy, which
  already holds the update, shortly after applying it. Waiting for the next
  save would leave the index stale until the user typed, because a peer's
  update never schedules a save (ADR 0010, decision 3).
- **No page is running.** The document waits for the backfill that already
  runs at startup (`reindexAndCollect`). That backfill now also runs whenever
  the page comes back on screen, since a phone's page can outlive days of
  background runs without ever starting again.

Attachment collection already waits while any document is unindexed (ADR
0013), so nothing is collected on a stale index.

**8. The core does not depend on Tauri.** It takes a data directory and an
event sink. Under Tauri the sink emits events to the page. In a background run
on a phone (ADR 0034) there is no page, and the sink drops them.

There is one core per process. Whichever of the app and a background run
starts first creates it, and both share it, so the database is never opened
twice and the port never bound twice.

**9. The page learns about sync from events.** Rust sends as events:

- each device's phase and progress
- which devices are connected
- when each device last synced
- every change a peer makes to the list of documents: one created, renamed,
  pinned or deleted

A command reads the current state when a page loads. `syncStore` and
`appStore` keep their shape; only what feeds them changes, where
`DocumentRepository` updates `appStore` today. A peer deleting the open note
is handled as it is now (`documentView.ts`).

**10. It ships with ADRs 0032 and 0033, as one breaking release.** The
protocol's transport and the content hash change with it, and every device
updates together, as ADR 0007 already requires of any wire change.

## Alternatives considered

**Keep the engine in the webview, and keep a webview alive.** Works on desktop
with ADR 0030's workarounds, which is why that ADR exists. Does nothing for a
phone, where background work gets no page it can rely on (see the context).

**Run the TypeScript protocol in a headless JavaScript engine** on the phones
(Android's JavaScriptEngine, JavaScriptCore on iOS). There is no DOM for the
indexer, no WebRTC and no Tauri bridge, so the transport and storage would
have to be in Rust anyway. That leaves one protocol split across two
languages.

**A Rust engine for background runs only, next to the webview one.** Two
implementations of one protocol that talk to each other and must never
disagree, for the lifetime of the app. Rejected.

**Port the indexer to Rust now,** so a background merge is indexed at once.
Deferred. `documentIndex.ts` walks ProseMirror nodes built from the editor's
schema, and a Rust copy reading the XML fragment directly would have to match
it exactly. That is the drift ADR 0013 decision 2 exists to prevent. Search,
backlinks and the todo list are only read by the page, so an index built when
the page next runs costs nothing anyone can see.

**Keep sending whole snapshots from the editor.** Simpler, but it only works
while the editor is the only writer. Decision 3 needs merges, and a delta is
also far less to carry over IPC.

## Consequences

- The bulk of sync no longer crosses IPC. Only the open document's deltas, its
  remote updates and status do. The cost ADR 0016 describes goes, and so does
  the objection ADR 0018 had to a Rust data plane, that every sync byte would
  cross IPC.
- There are two CRDT implementations in the app, Yjs 13.6 in the editor and
  `yrs` in Rust. They share a binary format, not code, and do not write
  identical bytes (ADR 0033).
  - A test merges updates the real editor wrote, over fixtures with tables,
    task lists, tags, links and images, into `yrs`, and the reverse.
  - Upgrading either one reruns it. Yjs 14 is in release candidates.
- Search, backlinks, tags and the todo list lag for a document merged while no
  page was running, until the page next starts or comes back on screen.
  Nothing shows them in the meantime.
- Sync no longer restarts when the page reloads.
- What goes from the frontend:
  - `DocumentRepository.ts` shrinks to opening documents, applying pushed
    updates and sending local ones.
  - `transport.ts`, `DocSyncProtocol.ts`, `reconcile.ts`, `Framing.ts`,
    `writeQueue.ts`, `hash.ts`, `iceRewrite.ts` and `signaling/` go.
  - Importing a backup (ADR 0024) decides by the same `reconcile()` today, and
    moves to calling the Rust rules, so the two still cannot drift apart.
- The pairing gap DEVELOPMENT.md describes, where `save_pair` persists
  whatever node_id the page hands it, closes with decision 6 and ADR 0032.
- Nothing in the core needs a window, so a headless build becomes possible:
  an always-on device for a NAS or a spare Linux box, paired like any other.
- Before building, a spike confirms two things:
  - `yrs` round-trips real notes with Yjs.
  - The core finds the same data directory from a phone's background entry
    point as Tauri's `app_data_dir()` gives the app.
