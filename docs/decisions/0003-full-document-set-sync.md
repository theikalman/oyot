# 0003: Reconcile the whole document set with a manifest + delta protocol

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

[ADR 0001](0001-mqtt-over-iroh-for-signaling.md) put CRDT sync on a WebRTC data
channel; [ADR 0002](0002-signaling-retry-and-perfect-negotiation.md) made the
connection itself reconnect reliably. What crossed that channel was still wrong.

On connect each peer sent a `doc-list` (title/timestamp per document). The
receiver materialised a row for any unknown document, then pulled its CRDT
content **only if** `local.updated_at < peer.updated_at`. But `ensure_document`
inserts the new row with `updated_at` copied from the peer's manifest, so the
comparison was `x < x` and content was never pulled. A freshly paired device
ended up with every title and almost no content - the only documents that filled
in were the one open in its editor at connect time (a special-case catch-up) and
any document subsequently edited live on the other device.

`updated_at` is the wrong primitive for "do these two copies differ?": it is
wall-clock, set by whichever device wrote last, copied across devices by
`ensure_document`, and re-stamped to `now()` on every merge. It cannot express
"we have diverged". Yjs already ships the right primitive - state vectors and
`encodeStateAsUpdate(doc, remoteStateVector)`.

Create, rename and delete had the same shape of bug: they propagated only as
best-effort live broadcasts, which an offline or newly-paired device never sees.

## Decision

**1. Two-phase reconciliation on every (re)connection, for the entire set.**

- *Manifest.* Each peer sends one `sync-manifest` listing every document it knows
  - tombstones included - with a **content hash**, `title_updated_at`, and
  `deleted_at`.
- *Delta.* For each document whose hashes differ (or that the receiver lacks),
  the receiver sends `sync-need { id, stateVector }`; the holder replies
  `sync-delta { id, update }` where `update = Y.encodeStateAsUpdate(doc,
  stateVector)`. Both peers run both phases, so the set converges in both
  directions. After a merge the hashes match and the next manifest is a no-op.

The sync layer no longer has any notion of a "currently open document" - that
special case existed only because whole-set sync did not work.

**2. Content hash, not timestamp, is the change detector.** `content_hash` is
`SHA-256` of the merged Yjs state, written on the row in the same statement as
`crdt_state`. Yjs update encoding is deterministic for a given operation set, so
byte-equal state hashes equally on every device: equal hash in a manifest means
"identical, skip"; unequal means "exchange state vectors and pull the real
delta". Rust only stores the bytes the frontend computes.

**3. CRDT diffing stays in TypeScript (`yjs`).** Responding to `sync-need` loads
the stored state blob into a transient `Y.Doc` and calls `encodeStateAsUpdate`.
This runs on sync events, never on the editor hot path, and the blob is a single
pre-merged snapshot. `DocumentRepository` is the sole module where Tauri document
commands and Yjs meet, so a future move into Rust (`yrs`) is localised.

**4. Metadata is last-writer-wins on an explicit `title_updated_at`.** Content is
a CRDT and merges; the title is not. A dedicated column, set to `now()` only on
an actual rename, is a better tiebreak than the content `updated_at`.
`apply_remote_rename` ignores an older-or-equal stamp. Clock skew is acceptable
for a title and self-heals on the next rename.

**5. Deletion is a tombstone.** `is_deleted = 1` rows are kept and carried in the
manifest with `deleted_at`. A tombstone wins over a concurrent edit (consistent
with 4). `apply_remote_delete` is idempotent and drops the CRDT history like a
local delete.

**6. Every data-channel message goes through a chunked framing layer.** A
document with an embedded base64 image exceeds the safe SCTP message size. One
`Framing` module splits/reassembles every message and honours
`bufferedAmountLowThreshold`. This also fixed the pre-existing unbounded
`channel.send` of full snapshots.

**7. Protocol version 2, negotiated via `hello`.** Because this is a personal
device-to-device app, there is no v1 compatibility path: a peer that does not
speak v2 is surfaced as "needs updating" and its connection skips
reconciliation.

**8. One local write path.** Inbound sync writes and UI-initiated writes both go
through `DocumentRepository` / `services/documentActions.ts`. The sidebar renders
from one store that those update. The dead parallel stack (`services/sync.ts`,
the second `syncStore` in `stores/app.ts`, the never-started `YjsSyncService`)
was removed.

## Alternatives considered

**Move CRDT sync into Rust with `yrs`.** The cleanest separation - Rust owns
persistence and CRDT logic, TS ships opaque bytes. Rejected as too large for this
change: a second CRDT implementation that must stay bit-compatible with the
editor's `yjs`, a rewrite of the save/merge/load paths, and new rollout failure
modes. The `DocumentRepository` boundary is drawn so this stays a localised
future change.

**Just fix the guard** (`justCreated || !hasContent || behind`). The minimal bug
fix. Rejected as the target: it keeps `updated_at` semantics and the open-doc
special case, never converges two already-non-empty divergent copies, and does
not propagate delete/rename to offline peers.

**Full state vectors in the manifest instead of a hash.** Avoids the hash column
but forces loading every document into a `Y.Doc` on every connect just to build
the manifest. The hash lets an unchanged set cost one SQL query and zero Yjs
work; state vectors are exchanged only for documents that actually differ.

**Broadcast every document's full state on connect.** Trivial and correct, but
re-transfers the whole corpus on every reconnect, including after a 5-second
Wi-Fi blip.

**Lamport / hybrid-logical clock for the title tiebreak.** More correct under
skew. Deferred - a wrong title on a tie is low-stakes and self-heals; the column
can hold a logical counter later without a protocol change.

## Consequences

- Whole-set sync is correct and automatic; the sync layer is decoupled from which
  document is open.
- First pair transfers the corpus once, chunked; subsequent reconnects are gated
  by the hash and cost almost nothing.
- New load-bearing invariant: `content_hash` must be written on every content
  change (enforced in `save_yjs_update` and `DocumentRepository`). A missed write
  degrades to a redundant state-vector exchange, not data loss.
- Rows written before this change have `content_hash = NULL`; a one-time backfill
  on first launch fills them, and NULL is treated as "force a state-vector
  exchange" until then.
- Tombstones accumulate in `documents`. Acceptable; pruning tombstones that all
  paired devices have acknowledged is a future task.
- Title conflicts resolve last-writer-wins by wall clock - documented,
  self-healing.
- `updated_at` is now display-only ("edited 3m ago"), not a sync input.
