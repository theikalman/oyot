# Full Document-Set Sync - Implementation Plan

> **Status: proposed.** Targets the bug where pairing a new device only syncs the
> currently-open document (plus whatever later receives a live edit), instead of
> replicating the whole document set. This plan reworks the sync layer so the
> document set converges correctly and automatically on every connection, with a
> clean protocol, a clean module structure, and correct UI feedback.

## 1. Problem statement

When Device B is paired to Device A for the first time:

- B receives A's document manifest (`doc-list`) and creates a local metadata row
  for every document via `ensure_document`.
- B then pulls **CRDT content** for a document only if
  `localDoc.updated_at < meta.updatedAt` (`WebRtcSyncService.ts:244`).
- `ensure_document` inserts the new row with `updated_at = meta.updatedAt`
  (`commands/documents.rs:189`), so the comparison is `x < x` -> **false**, and
  content is never requested.

Net result: B ends up with titles but no content for every document, except:

1. the document open in B's editor at connection time - the `channel.onopen`
   catch-up explicitly requests state for `get(currentDocument)`
   (`WebRtcSyncService.ts:837-841`); and
2. any document that subsequently receives a live `crdt-update` broadcast - i.e.
   you edit the active document on A (`EditorSaveService.ts:86`).

That matches the reported symptom exactly.

### Why a point fix is not enough

`updated_at` is the wrong primitive for "does my copy differ from yours?":

- it is wall-clock, set by whichever device last wrote, and copied across devices
  by `ensure_document`;
- `save_yjs_update` stamps it to `now()` on merge (`commands/sync.rs:62`), so two
  devices editing the same doc drift regardless of actual content;
- the comparison is one-directional - it never expresses "we have diverged".

Yjs already ships the correct primitive (state vectors / `encodeStateAsUpdate(doc,
remoteStateVector)`). The sync layer should use it, and should not have a
"currently open document" concept at all - that special case only exists to paper
over the fact that whole-set sync does not work.

## 2. Goals

1. **Whole-set convergence.** After two paired devices connect, every non-deleted
   document present on either device exists, with identical content, on both -
   regardless of which document (if any) is open, and regardless of whether any
   edit happens after connecting.
2. **Correct change detection.** "Do these two copies differ?" is answered by
   document content, not by timestamps. Only the actual delta crosses the wire.
3. **Creation, rename and deletion converge through the same mechanism** - not
   just via best-effort live broadcasts that a freshly-paired or
   reconnecting-after-offline device misses.
4. **Idempotent and interruptible.** A connection that drops mid-sync resumes on
   reconnect and transfers only what is still missing.
5. **Correct UI.** The sidebar reflects the converging document set live; each
   paired device shows a real sync phase ("Syncing 4/17..." -> "Synced - just
   now"); "Last sync" actually updates.
6. **Clean structure.** The 960-line `WebRtcSyncService.ts` is split into
   focused modules with a single, testable protocol core and a single CRDT/DB
   boundary. The dead parallel sync stack is removed.

### Non-goals (track separately)

- Broker auth/TLS, TURN, the QR/discovery hardening items in `CURRENT_ISSUES.md`.
- Moving CRDT logic into Rust (`yrs`) - see Alternatives (11.1).
- Real-time multi-writer presence/cursors beyond what TipTap already does on an
  open document.
- Attachment/blob sync over the data channel (images embedded as base64 inside
  the CRDT are covered; the `attachments` table path is not).

## 3. Current state (reference)

| Concern | Where | Behaviour today |
| --- | --- | --- |
| Manifest exchange | `WebRtcSyncService.ts:316` `sendDocList` | sends `list_document_metadata` (all non-deleted docs) on channel open |
| Content pull decision | `WebRtcSyncService.ts:219` `reconcileRemoteDoc` | `ensure_document` if unknown; request state **iff** `local.updated_at < meta.updatedAt` (never true for a just-created row) |
| Open-doc catch-up | `WebRtcSyncService.ts:837-841` | special-case: request state for `currentDocument` only |
| Live edit push | `EditorSaveService.ts:86` -> `broadcastDocUpdate` | whole `Y.encodeStateAsUpdate` snapshot, **no chunking** |
| Create / rename / delete | `Sidebar.svelte`, `+page.svelte` call `broadcastDoc*` | live-only; missed by offline/newly-paired peers until next manual edit |
| Merge inbound | `WebRtcSyncService.ts:152` `mergeRemoteDocUpdate` | load `crdt_state` -> applyUpdate -> re-encode -> `save_yjs_update` |
| State storage | `documents.crdt_state` BLOB + `yjs_updates` log + `yjs_snapshots` | `get_yjs_state` returns `crdt_state` (full merged state) |
| Sync phase in UI | - | none; `ConnectedPeerList` shows "Last sync" but `update_pair_sync_time` is never called from TS |
| `SyncStatus.svelte` | reads `stores/app.ts` `syncStore` | legacy store, not fed by the real signaling path - effectively dead |
| Legacy stack | `services/sync.ts`, `stores/app.ts` `syncStore`, Rust `webrtc_manager` / `peer_registry` | partially wired, superseded by `WebRtcSyncService.ts` + JS `RTCPeerConnection` |
| DB migrations | `lib.rs:17` `setup_database_tables` | `CREATE TABLE IF NOT EXISTS` only - no `ALTER`/versioning |

Deps available: `yjs` (TS). Rust: `rusqlite`, `serde`. No hashing crate wired yet.

## 4. Target architecture

### 4.1 Design decisions

**D1 - The sync layer is document-set-agnostic.** It reconciles *all* documents
on connect. There is no "open document" fast path. The editor is just one more
consumer of the same local store the sync layer writes to.

**D2 - Two-phase reconciliation per connection.**

- *Phase 1 - Manifest.* Each peer sends one `sync-manifest`: every document it
  knows about (including tombstones) with a cheap **content hash** and metadata.
- *Phase 2 - Delta.* For each document where the hashes differ (or the receiver
  lacks it), the receiver sends `sync-need { id, stateVector }`; the holder
  replies `sync-delta { id, update }` computed as
  `Y.encodeStateAsUpdate(ydoc, theirStateVector)`. Both peers do this
  symmetrically, so both directions converge. After merge the hashes match and
  the next manifest is a no-op.

**D3 - Content hash, not timestamp, is the change detector.** `content_hash` is a
32-byte digest of the merged CRDT state, stored on the row and updated in the
same write as `crdt_state`. Equal hash => identical document => skip. Unequal =>
do the state-vector exchange (which is what actually decides the minimal delta).
Rust computes the hash; it needs no Yjs knowledge.

**D4 - CRDT diffing stays in TypeScript (yjs).** Rust does not gain a second CRDT
implementation. Responding to `sync-need` loads the document's stored
`crdt_state` blob into a transient `Y.Doc` and calls `encodeStateAsUpdate`. This
happens on sync events, never on the editor hot path; the blob is a single
pre-merged snapshot so `applyUpdate` is fast. (Future: move to a Web Worker -
11.2.)

**D5 - Metadata (title) is last-writer-wins on an explicit `title_updated_at`.**
Content is a CRDT and merges; the title is not, so it needs a tiebreak. A
dedicated `title_updated_at` column (set to `now()` only on an actual rename) is
a better signal than the content `updated_at`. Clock skew is acceptable for a
title; a Lamport clock is the follow-up if it ever bites (11.3).

**D6 - Deletion is a tombstone.** `is_deleted = 1` rows are kept and carried in
the manifest with `deleted_at`. A tombstone wins over concurrent edits (LWW,
consistent with D5). Documented as a deliberate choice.

**D7 - All data-channel messages go through a chunked framing layer.** Yjs state
with embedded base64 images exceeds safe SCTP message sizes. One `Framing`
module splits/reassembles every message and honours `bufferedAmountLowThreshold`
backpressure. This also fixes the latent no-chunking bug in today's
`broadcastDocUpdate`.

**D8 - One local write path.** Inbound sync writes and UI-initiated writes both
go through a single `DocumentRepository` (TS) over a stable set of Tauri
commands. The sidebar renders from one store that the repository updates; no more
scattered `appStore.addDocument` calls.

**D9 - Live steady-state broadcasts are kept as an optimisation, not the
mechanism.** While connected, a local edit still broadcasts `sync-delta`
immediately and a create/rename/delete still broadcasts its metadata op. These
are pure latency optimisations; correctness comes entirely from Phase 1/2, which
re-runs on every (re)connection.

### 4.2 Module structure (TypeScript)

Replace `src/lib/services/WebRtcSyncService.ts` with `src/lib/sync/`:

```
src/lib/sync/
  index.ts                  Public API: initSync(), shutdownSync(),
                            broadcastLocalUpdate(), broadcastMetadataOp().
                            Owns wiring; no protocol logic.
  signaling.ts              MQTT lifecycle: invoke('mqtt_connect'), the
                            mqtt-* event listeners, signalingStatus store.
                            (Lift from initSync/setupEventListeners.)
  PerfectNegotiator.ts      One RTCPeerConnection: perfect-negotiation state
                            machine, epoch tagging, ICE, connectionState ->
                            events. (Lift from ensurePeerConnection +
                            handleDescription + handleIceCandidate.)
  PeerConnectionManager.ts  The set of negotiators: reconnect sweep, per-peer
                            backoff, suppressReconnect, pairing entry points.
                            (Lift from reconnectAllPairedDevices,
                            scheduleReconnect, initiateOffer, disconnectPeer.)
  channel/Framing.ts        chunk/reassemble + backpressure over one
                            RTCDataChannel. sendMessage(ch, msg) / onMessage.
  channel/DocSyncProtocol.ts  Phase 1 + Phase 2 state machine for one channel.
                            Pure logic against a DocumentRepository interface
                            and a Framing send fn. Emits progress events.
  DocumentRepository.ts     The only place Tauri doc commands + yjs are called:
                            listSyncState(), getState(), computeDelta(),
                            mergeDelta(), ensureDoc(), applyRename(),
                            applyDelete(). Updates the documents store.
  protocol.ts               Wire message types + manifest-entry type + the
                            protocol version constant.
```

`stores/sync.ts` gains per-room sync phase (5.4). `EditorSaveService` calls
`DocumentRepository.saveLocalUpdate()` then `sync.broadcastLocalUpdate()`.

### 4.3 Removals

- Delete `src/lib/services/sync.ts` and the second `syncStore` (+ `SyncStatus`
  type, `syncPeers`, `syncStatus`) in `src/lib/stores/app.ts`.
- Drop the `initializeSync` / `getSyncCleanup` calls in `src/routes/+page.svelte`.
- Rewrite `SyncStatus.svelte` to derive from `stores/sync.ts` (signaling status +
  aggregate room phase).
- Rust: leave `webrtc_manager` / `peer_registry` / `services/sync.rs` broadcast
  code in place for now (removing it is a separate cleanup), but stop calling the
  dead `broadcast_message` from `save_yjs_update` once the TS path owns delivery -
  or leave it; it is a no-op with no registered channels. Note in the ADR.

## 5. Detailed changes

### 5.1 Rust - schema & migration

**New file `src-tauri/src/db_migrations.rs`** (or a function in `lib.rs`), run
right after `setup_database_tables`:

```rust
pub fn run_migrations(db: &Connection) -> Result<(), String> {
    let v: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
    if v < 1 {
        db.execute_batch("
            ALTER TABLE documents ADD COLUMN content_hash BLOB;
            ALTER TABLE documents ADD COLUMN title_updated_at INTEGER;
            ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
            UPDATE documents SET title_updated_at = updated_at WHERE title_updated_at IS NULL;
        ").map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA user_version = 1;").ok();
    }
    Ok(())
}
```

`content_hash` stays NULL until the first save (or the backfill in 5.6) - the
protocol treats NULL as "unknown, force a state-vector exchange".

### 5.2 Rust - `commands/sync.rs`

**`save_yjs_update`** gains an optional `content_hash: Option<Vec<u8>>` param
(the TS side passes `blake3(merged_state)` or a SHA-256; pick one and keep it
stable). Persist it in the existing `UPDATE documents SET crdt_state = ?, ...`:

```rust
db.execute(
    "UPDATE documents SET crdt_state = ?, content_hash = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
    params![&merged_state, &content_hash, now, &doc_id],
)?;
```

Keep `updated_at = now()` for display ("edited 3m ago") - it is no longer load-
bearing for sync. Drop the dead `webrtc_manager.broadcast_message` call (or keep;
it is inert).

**New `list_document_sync_state`** - replaces `list_document_metadata` for sync:

```rust
#[derive(Serialize)]
pub struct DocSyncEntry {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title_updated_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub content_hash: Option<Vec<u8>>, // NULL => unknown
}
// SELECT ... FROM documents   (NO is_deleted filter - tombstones included)
```

**New `get_all_documents_full`** (or extend `get_all_documents` with an
`include_empty: bool`) - returns all non-deleted docs regardless of whether they
have content yet, so the sidebar can show a doc that is mid-sync. Row adds
`has_content` as today.

### 5.3 Rust - `commands/documents.rs`

- **`ensure_document`**: add `title_updated_at: i64` param; store it. Still
  `INSERT OR IGNORE` (never clobber a known row here).
- **New `apply_remote_rename`**: LWW rename used by the sync layer:
  ```
  UPDATE documents SET title = ?1, title_updated_at = ?2
  WHERE id = ?3 AND (title_updated_at IS NULL OR title_updated_at < ?2)
  ```
  Also update `document_index.title`. Return whether it applied.
- **New `apply_remote_delete`**: `UPDATE documents SET is_deleted = 1,
  deleted_at = ?` (idempotent); then `snapshot.delete_document_data`.
- **`update_document`** (local rename): set `title_updated_at = now()`.
- **`delete_document`** (local): set `deleted_at = now()`.
- **`create_document` / `get_or_create_today_journal` / `ensure_document`**: set
  `content_hash = NULL`, `title_updated_at = now()` (or `created_at`).
- Keep `get_yjs_state` (full-state fallback for empty state vector).

Register the new commands in `lib.rs`.

### 5.4 TypeScript - `stores/sync.ts`

```ts
export type RoomSyncPhase = 'idle' | 'reconciling' | 'transferring' | 'synced' | 'error';
interface RoomSync { phase: RoomSyncPhase; pending: number; total: number; lastSyncedAt: number | null; }
// syncStore gains: roomSync: Record<string /*roomId*/, RoomSync>
// actions: setRoomPhase(roomId, phase), setRoomProgress(roomId, pending, total), setRoomSyncedAt(roomId, ts)
// derived: aggregateSyncPhase  (worst non-synced phase across connected rooms, else 'synced'/'idle')
```

### 5.5 TypeScript - protocol (`sync/protocol.ts`)

```ts
export const SYNC_PROTOCOL_VERSION = 2;

export interface ManifestEntry {
    id: string;
    docType: string;
    title: string;
    titleUpdatedAt: number;
    createdAt: number;
    isDeleted: boolean;
    deletedAt: number | null;
    contentHash: string | null; // base64; null => unknown
}

export type SyncMessage =
    | { t: 'hello'; v: number }
    | { t: 'sync-manifest'; docs: ManifestEntry[] }
    | { t: 'sync-need'; id: string; sv: string }          // sv = base64 state vector
    | { t: 'sync-delta'; id: string; update: string }     // base64 update; framing layer chunks it
    | { t: 'sync-done' }                                   // sender has finished emitting needs
    | { t: 'doc-created'; entry: ManifestEntry }           // live optimisation
    | { t: 'doc-renamed'; id: string; title: string; titleUpdatedAt: number }
    | { t: 'doc-deleted'; id: string; deletedAt: number }
    | { t: 'live-update'; id: string; update: string };    // live edit optimisation
```

### 5.6 TypeScript - `sync/DocumentRepository.ts`

Single boundary between the protocol and (Tauri commands + yjs):

- `listSyncState(): Promise<ManifestEntry[]>` - wraps `list_document_sync_state`,
  base64s `content_hash`.
- `localStateVector(id): Promise<string>` - `get_yjs_state` -> `new Y.Doc()` ->
  `applyUpdate` -> `Y.encodeStateVector` -> base64. Returns the empty-doc vector
  if no content.
- `computeDelta(id, remoteSvB64): Promise<string | null>` - load doc, `diff =
  Y.encodeStateAsUpdate(doc, base64ToBytes(remoteSv))`; return null if `diff` has
  no ops (length 2 == empty-update sentinel) else base64.
- `mergeDelta(id, updateB64): Promise<void>` - today's `mergeRemoteDocUpdate`,
  plus: recompute `contentHash` and pass to `save_yjs_update`; then
  `documentsStore.markHasContent(id)` and emit a `documents-changed` signal.
- `ensureDoc(entry)`, `applyRename(id,title,ts)`, `applyDelete(id,ts)` - wrap the
  new `ensure_document` / `apply_remote_rename` / `apply_remote_delete`, then
  update the documents store.
- `saveLocalUpdate(id, ydoc)` - used by `EditorSaveService`: `save_yjs_update`
  with a fresh `contentHash`.
- `hash(bytes)` - the agreed digest (match Rust: e.g. SHA-256 via
  `crypto.subtle.digest`), base64.

**Backfill:** on first run after upgrade, `DocumentRepository.backfillHashes()`
iterates docs with `content_hash == null && has_content`, loads each, writes the
hash. Cheap, one-time, runs off the critical path.

### 5.7 TypeScript - `sync/channel/Framing.ts`

```ts
const MAX_CHUNK = 16 * 1024;          // portable SCTP payload
const BUFFER_HIGH = 1 * 1024 * 1024;  // pause sending above this
// sendMessage(ch, obj):
//   json -> Uint8Array; if <= MAX_CHUNK send one {f:0} frame;
//   else send {f:'begin', id, total}, then N {f:'chunk', id, seq, b64},
//   awaiting 'bufferedamountlow' whenever ch.bufferedAmount > BUFFER_HIGH.
// attach(ch, onMessage): reassembles; on 'begin' allocate, on last 'chunk' -> onMessage(parsed).
```

Used for *every* `SyncMessage`. Fixes the current unbounded `channel.send` in
`broadcastDocUpdate`.

### 5.8 TypeScript - `sync/channel/DocSyncProtocol.ts`

One instance per open data channel. Holds `roomId`, a `DocumentRepository`, and a
`send: (m: SyncMessage) => void`.

**On open:**
1. `send({ t:'hello', v: SYNC_PROTOCOL_VERSION })`.
2. `send({ t:'sync-manifest', docs: await repo.listSyncState() })`.
3. `syncStore.setRoomPhase(roomId, 'reconciling')`.

**On `hello`:** if `v !== SYNC_PROTOCOL_VERSION`, log + degrade (2.b: for a
personal app, require matching versions; show a "update your other device" toast
and stop). Otherwise ignore.

**On `sync-manifest`:**
- Build a set of local entries (`repo.listSyncState()`), keyed by id.
- For each remote entry:
  - `isDeleted` and local not deleted -> `repo.applyDelete(id, deletedAt)`.
  - not deleted, local missing -> `repo.ensureDoc(entry)`; queue `need` with
    empty state vector.
  - not deleted, local present, `contentHash` differs or either is null -> queue
    `need` with `repo.localStateVector(id)`.
  - `titleUpdatedAt > localEntry.titleUpdatedAt` -> `repo.applyRename(...)`.
- `total = queue.length`; `syncStore.setRoomProgress(roomId, total, total)`.
- Drain the queue with small `await` gaps (stagger), sending each
  `{ t:'sync-need', id, sv }`. Then `send({ t:'sync-done' })`.
- If nothing queued and `sync-done` already received from peer ->
  `finish()`.

**On `sync-need { id, sv }`:** `const u = await repo.computeDelta(id, sv);` if
`u` -> `send({ t:'sync-delta', id, update: u })`.

**On `sync-delta { id, update }`:** `await repo.mergeDelta(id, update)`;
`pending--`; `syncStore.setRoomProgress(roomId, pending, total)`; if
`pending === 0 && peerDone` -> `finish()`.

**On `sync-done`:** `peerDone = true`; if our queue is drained -> `finish()`.

**`finish()`:** `syncStore.setRoomPhase(roomId, 'synced')`;
`syncStore.setRoomSyncedAt(roomId, Date.now())`; `invoke('update_pair_sync_time',
{ roomId })` then refresh `pairedDevices`.

**Live messages** (`doc-created` / `doc-renamed` / `doc-deleted` /
`live-update`): route straight to the matching `repo.*` method. These can arrive
before, during, or after reconciliation - all `repo` methods are idempotent and
CRDT merges commute, so ordering does not matter.

**Guardrails:**
- Cap concurrent in-flight `sync-need` (e.g. 4) to bound memory when a peer has
  hundreds of divergent docs.
- A `need` with no `delta` answer within a timeout is re-queued once, then
  dropped with a logged warning (the next reconnect's manifest will retry).
- `computeDelta` / `mergeDelta` failures are logged per-doc and do not abort the
  room's sync.

### 5.9 TypeScript - `PerfectNegotiator` / `PeerConnectionManager`

Mechanically lifted from today's `WebRtcSyncService.ts` (the perfect-negotiation
logic is sound - ADR 0002 - and is not what is broken). Changes:

- `channel.onopen` no longer does the "currently open doc" catch-up. It
  constructs a `DocSyncProtocol` bound to the channel via `Framing` and lets it
  drive.
- `channel.onmessage` -> `Framing.attach` -> `DocSyncProtocol.handle`.
- On `connectionState === 'connected'` set room phase `reconciling` (protocol
  will move it to `synced`); on drop set `idle`/`error`.

### 5.10 TypeScript - editor & document services

- **`services/documents.ts`** becomes the single owner of create/rename/delete:
  each function calls the Rust command, updates the documents store, and calls
  `sync.broadcastMetadataOp(...)`. `Sidebar.svelte` and `+page.svelte` call these
  instead of invoking + broadcasting inline.
- **`EditorSaveService.performSave`**: `await repo.saveLocalUpdate(docId, ydoc)`
  then `sync.broadcastLocalUpdate(docId, update)`. Keep
  `appStore.markDocumentHasContent`.
- **`Editor.svelte` / `YjsSyncService`**: keep exactly one `sync-received`
  listener that reloads the open doc's ydoc. Remove the duplicate (the plan
  picks `YjsSyncService`; `Editor.svelte`'s copy goes). Out-of-scope docs need no
  handler - they are not open.

## 6. UI

### 6.1 Sidebar - "Notes" / "Journals"

- Render from the documents store fed by `DocumentRepository`. A doc learned
  from a peer appears immediately (metadata), with a subtle `syncing` affordance
  (small spinner / dimmed title) while `!has_content`, resolving to normal once
  the delta merges. Use `get_all_documents_full` on load so a mid-sync doc
  survives a refresh.
- Deleted-remotely doc disappears when `apply_remote_delete` updates the store.
- Journals count updates the same way.

### 6.2 Sidebar - "Connected Devices" & `ConnectedPeerList.svelte`

Per paired device, driven by `stores/sync.ts` `roomSync[roomId]`:

| phase | label |
| --- | --- |
| offline | `Offline` |
| connecting | `Connecting...` |
| reconciling | `Syncing...` |
| transferring | `Syncing N/M...` (from `pending`/`total`) |
| synced | `Synced - {formatLastSync(lastSyncedAt)}` |
| error | `Sync error - retrying` |

"Last sync" now has real data because `finish()` calls `update_pair_sync_time`.

### 6.3 `SyncStatus.svelte` (top bar)

Rewrite to derive from `stores/sync.ts`:
- dot colour from `signalingStatus` + `aggregateSyncPhase`;
- label: `Offline` / `Connecting` / `Syncing...` / `Synced`;
- peer count from `connectedPeers.length`.

Delete the `stores/app.ts` `syncStore` it currently reads.

### 6.4 First-pair feedback

When a pair is accepted, `PairingDialog` / sync page shows the new device moving
through `Connecting -> Syncing N/M -> Synced`, so the user sees the whole set
replicate instead of wondering whether it worked.

## 7. Wire-protocol walk-through (fresh pair)

```
A: docs D1..D10 (content).            B: empty.
channel opens on both sides.

A -> B: hello{v2}; sync-manifest{D1..D10, each contentHash set}
B -> A: hello{v2}; sync-manifest{[]}

B: all 10 unknown -> ensureDoc x10 (metadata rows, sidebar shows them "syncing")
   queue need{Di, sv=<empty doc>} x10 ; phase transferring 0/10
B -> A: sync-need{D1,svE} .. sync-need{D10,svE}; sync-done
A: (manifest from B empty) -> nothing to need ; sync-done

A -> B: sync-delta{D1,<full state>} .. (Framing chunks the big/image docs)
B: mergeDelta x10 -> save_yjs_update -> markHasContent -> pending 10..0
B: pending 0 && peerDone -> finish() -> phase synced, update_pair_sync_time
A: our-queue empty && peerDone -> finish() -> phase synced
```

Reconnect after B edits D3 offline: manifests now differ only on D3
(`contentHash` mismatch); each side sends `need{D3, sv}`, each replies with the
~small delta, both merge, done. No full transfer.

## 8. Migration & rollout

- **DB**: additive `ALTER TABLE` behind `PRAGMA user_version` (5.1). Safe on
  existing installs; NULL `content_hash` handled by the protocol.
- **Hash backfill** (5.6) runs once on the first launch of the new build.
- **Protocol version**: bump to `2`. Because this is a personal
  device-to-device app, do **not** carry the legacy `doc-list` path; instead, if
  a peer speaks `v1` (no `hello`, or `hello.v !== 2`), show "One of your devices
  needs updating to sync" and skip reconciliation for that connection. One
  release of ugliness, then delete.
- Ship behind no flag - the old behaviour is a bug, not a feature.

## 9. Testing

### 9.1 Rust unit tests (`commands/*` with an in-memory `Connection`)
- `run_migrations` is idempotent; columns exist; `title_updated_at` backfilled.
- `list_document_sync_state` includes tombstones and NULL hashes.
- `apply_remote_rename` LWW: older `title_updated_at` no-ops, newer applies.
- `apply_remote_delete` idempotent; wipes updates/snapshots; row stays.
- `save_yjs_update` persists `content_hash`.

### 9.2 TS protocol tests (`DocSyncProtocol` with two fake repos + a mock channel)

A test harness wires two `DocSyncProtocol` instances through an in-memory
bidirectional channel; each backed by a `MapDocumentRepository` holding real
`Y.Doc`s. Assert convergence (equal `encodeStateAsUpdate` on both sides) for:

1. Fresh pair, A has N docs, B empty.
2. Both non-empty, disjoint sets.
3. Same doc, concurrent divergent edits on both sides.
4. Rename race (both rename; higher `titleUpdatedAt` wins on both).
5. Delete vs edit (tombstone wins).
6. Channel "drops" (harness stops mid-transfer) then reconnects -> only the
   remainder transfers (spy on `computeDelta` sizes).
7. Large doc (>1 MB, embedded image) -> `Framing` chunks + reassembles intact.
8. 200 divergent docs -> in-flight `need` cap respected; still converges.

### 9.3 Framing unit tests
- round-trip for sizes `{0, 1, MAX_CHUNK-1, MAX_CHUNK, MAX_CHUNK+1, 5 MB}`.
- interleaved messages on one channel reassemble independently.
- backpressure: `send` awaits when `bufferedAmount` is stubbed high.

### 9.4 Manual (the reported bug)
- Device A: 3 notes + 2 journals with content, 1 renamed, 1 deleted.
- Pair a fresh Device B. Without opening or editing anything on A: all 5 live
  docs appear on B with full content; the deleted one does not; the rename is
  reflected. "Synced - just now" shows on both.
- Kill B's network mid-sync; restore -> completes.
- Edit D on A after sync -> B updates within ~1s (live path).
- Cross-check with A and B swapped (polite/impolite roles).

## 10. Work breakdown

| # | Chunk | Depends on | Rough size |
| --- | --- | --- | --- |
| 1 | DB migration + schema (`content_hash`, `title_updated_at`, `deleted_at`) | - | S |
| 2 | Rust commands: `list_document_sync_state`, `apply_remote_rename`, `apply_remote_delete`, `save_yjs_update` hash param, `get_all_documents_full`, `ensure_document` param | 1 | M |
| 3 | `sync/protocol.ts` + `sync/DocumentRepository.ts` + hash helper + backfill | 2 | M |
| 4 | `sync/channel/Framing.ts` + tests (9.3) | - | M |
| 5 | `sync/channel/DocSyncProtocol.ts` + harness tests (9.2) | 3,4 | L |
| 6 | Split transport: `signaling.ts`, `PerfectNegotiator.ts`, `PeerConnectionManager.ts` from `WebRtcSyncService.ts`; wire `DocSyncProtocol` on channel open; delete open-doc catch-up | 5 | L |
| 7 | `stores/sync.ts` room phase + `services/documents.ts` consolidation + `EditorSaveService` / `YjsSyncService` dedupe | 6 | M |
| 8 | UI: `ConnectedPeerList`, sidebar devices + doc "syncing" state, `SyncStatus` rewrite, delete legacy `services/sync.ts` + `stores/app.ts` syncStore | 7 | M |
| 9 | Rust tests (9.1), manual pass (9.4), ADR 0003 | all | M |

Chunks 1-3 are safe to land incrementally (no behaviour change until 6). Chunk 6
is the switchover.

## 11. Alternatives considered

**11.1 Move CRDT sync into Rust with `yrs`.** The truly clean separation: Rust
owns all persistence *and* CRDT logic (state vectors, diffs, merges), TS just
ships opaque bytes and renders. Rejected for this plan as too large - it means a
second CRDT implementation that must stay bit-compatible with `yjs` in the
editor, a rewrite of `save_yjs_update` / `mergeRemoteDocUpdate` / the editor load
path, and new failure modes during rollout. Worth doing later; the module
boundary in 4.2 (`DocumentRepository` as the only yjs+DB caller) is drawn so that
swap is localised.

**11.2 Compute diffs off the main thread (Web Worker).** Loading a large doc into
a transient `Y.Doc` to answer `sync-need` can jank the UI. Deferred: measure
first; the blob is pre-merged so `applyUpdate` is O(state) once, and it only
happens on divergence. If it bites, move `DocumentRepository`'s yjs calls into a
worker - the interface already returns Promises.

**11.3 Lamport/hybrid-logical clock for title LWW.** More correct than wall-clock
`title_updated_at` under skew. Deferred - a wrong title on a tie is low-stakes
and self-heals on the next rename. The column can hold a logical counter later
without a protocol change.

**11.4 Keep pull-only, just fix the guard** (`justCreated || !hasContent ||
behind`). This is the minimal bug fix and is correct for the reported symptom,
but keeps `updated_at` semantics, keeps the "open doc" special case, does not
converge two already-non-empty divergent copies, and does not propagate
delete/rename to offline peers. Rejected as the target; usable as a stopgap if
the full plan needs to be staged.

**11.5 One `sync-manifest` with full state vectors instead of a content hash.**
Avoids the hash column, but forces loading every doc into a `Y.Doc` on every
channel open just to build the manifest. The hash lets an unchanged doc set cost
one SQL query and zero yjs work. Kept the hash; state vectors are exchanged only
for docs that actually differ.

**11.6 Broadcast-everything on connect (send every doc's full state).** Trivial
and correct, but re-transfers the entire corpus on every reconnect (including
after a 5-second Wi-Fi blip). The manifest+hash gate makes the steady-state
reconnect nearly free.

## 12. Consequences

- Whole-set sync is correct and automatic; the "open document" coupling in the
  sync layer is gone.
- Reconnects are cheap (hash gate); first pair transfers exactly the corpus once,
  chunked.
- New load-bearing invariant: `content_hash` must be written on every content
  change (enforced in `save_yjs_update` + `DocumentRepository`). A missed write
  degrades to a redundant state-vector exchange, not data loss.
- Tombstones accumulate in `documents`. Acceptable; a future "compact tombstones
  older than N months, that all paired devices have acked" task can prune them.
- `title` conflicts resolve LWW by wall clock - documented, self-healing.
- The dead parallel sync stack is removed, so there is one sync path to reason
  about.
