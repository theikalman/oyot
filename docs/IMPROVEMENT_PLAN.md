# Oyot Improvement Plan

Findings from a full review of the frontend, Rust backend, sync layer, build
configuration and CI, turned into an ordered work plan.

Phases are ordered by dependency, not just severity: CI lands first so every
later refactor is protected, data-loss bugs land next because users are hitting
them today, dead code is removed before the security rewrite so there is less
surface to reason about, and performance work comes last because it is only
measurable once the dead paths are gone.

Effort estimates are rough working time for someone already familiar with the
codebase.

| Phase | Theme                              | Items | Effort |
| ----- | ---------------------------------- | ----- | ------ |
| 0     | CI and tooling guardrails          | 3     | ~2h    |
| 1     | Data loss and blocking bugs        | 2     | ~5h    |
| 2     | Sync layer correctness             | 4     | ~4h    |
| 3     | Quick security and durability wins | 4     | ~2h    |
| 4     | Dead code removal                  | 6     | ~4h    |
| 5     | Authenticated signaling            | 5     | ~2d    |
| 6     | Performance                        | 4     | ~1d    |
| 7     | Feature gaps and docs              | 5     | ~1d    |

---

## Phase 0 - CI and tooling guardrails

> **Status: done.** See `.github/workflows/ci.yml` and `make verify`.

Nothing currently runs the test suite. `npm test` (17 passing), `npm run check`,
`cargo clippy` and `cargo test` all pass locally but are unenforced, so every
fix below could silently regress.

### 0.1 Add a CI workflow

Create `.github/workflows/ci.yml`, triggered on `push` and `pull_request`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run check
      - run: npm test

  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: rustfmt, clippy }
      - name: Install Linux system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev \
            libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml --check
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
      - run: cargo test --manifest-path src-tauri/Cargo.toml
```

Note the `rust` job needs the Tauri Linux system dependencies already documented
in `DEVELOPMENT.md`; without them `cargo clippy` fails on the `tauri` build
script.

`-D warnings` will fail on the ~10 existing clippy warnings, so 0.2 must land in
the same change.

**Acceptance:** a PR with a failing test or a clippy warning is blocked.

### 0.2 Clear the existing clippy warnings

```bash
cargo clippy --fix --manifest-path src-tauri/Cargo.toml --allow-dirty --lib -p oyot --tests
```

Handles the auto-fixable ones (`useless_vec` in `signaling_manager.rs:377` and
`pairing.rs:128`, `for (_, conn) in peers.iter()` in `peer_connection.rs:101`,
the `doc_lazy_continuation` items). The `type_complexity` warning on
`signaling_manager.rs:32` needs a manual alias:

```rust
type PublishSender = mpsc::Sender<(String, Vec<u8>)>;
```

Several of these warnings sit in files Phase 4 deletes outright, so do 0.2 as a
mechanical pass and do not invest in the doomed ones.

### 0.3 Add Prettier and ESLint configuration

`package.json` has a `format` script but no `.prettierrc`, so output depends on
whatever Prettier defaults ship with the installed version. Add a
`.prettierrc` matching the existing style (4-space indent, single quotes, 100
column width) and a `.prettierignore` covering `build/`, `dist/`, `.svelte-kit/`
and `src-tauri/gen/`. Add `eslint` with `eslint-plugin-svelte` and a `lint`
script, then wire `npm run lint` into the `frontend` CI job.

---

## Phase 1 - Data loss and blocking bugs

> **Status: done.** 1.2b landed as
> [ADR 0008](decisions/0008-deletion-as-last-writer-wins.md).

### 1.1 Stop dropping the last second of typing on every document switch

**File:** `src/lib/editor/Editor.svelte`, `src/lib/editor/EditorInstance.svelte`,
`src/lib/editor/EditorSaveService.ts`

**The bug.** `handleDocumentChange` guards on a synthesized `oldDoc`:

```js
async function handleDocumentChange(newDoc, oldDoc) {
    if (!newDoc || !oldDoc) return;          // always true
    if (saveService && previousDocId && ...) await saveService.forceSave();
    previousDocId = newDoc.id;               // never reached
```

`oldDoc` comes from `previousDocId ? { id: previousDocId } : null`, and
`previousDocId` starts `null`. The guard returns before the assignment that
would set it, so it stays `null` permanently and the flush never runs on any
switch. Meanwhile `EditorInstance` rebuilds on doc change, which calls
`handleEditorReady`, which calls `saveService.destroy()`, which clears the
pending 1000 ms debounce timer. Type, click another note within a second, the
edit is gone.

**Why the obvious fix is wrong.** Simply repairing the guard is not enough.
`Editor.svelte`'s effect and `EditorInstance`'s effect are independent, and the
flush is async. If `EditorInstance.initializeEditor` wins the race, the old
`saveService` is already destroyed (`isDestroyed = true`, `ydoc` nulled) and
`forceSave()` returns `null` having written nothing. Worse, a naive fix that
reads `this.ydoc` after the swap would write document B's empty state under
document A's id.

**The fix.** Make the flush capture `(docId, ydoc)` by value and happen
synchronously with respect to teardown.

Step 1 - extract the persist path in `EditorSaveService.ts` into a free function
that depends on nothing mutable:

```ts
// Persist a snapshot and tell peers. Takes everything by value so it is safe to
// call while the editor that produced `snapshot` is being torn down.
export async function persistSnapshot(docId: string, snapshot: Uint8Array): Promise<void> {
  if (snapshot.length === 0) return;
  await documentRepository.saveLocalUpdate(docId, snapshot);
  broadcastLocalUpdate(docId, bytesToBase64(snapshot));
  appStore.markDocumentHasContent(docId);
}
```

Rewrite `performSave` to call it, and add a `flushNow()` that encodes
synchronously before returning the promise:

```ts
flushNow(): Promise<void> | null {
    if (this.isDestroyed || !this.ydoc || !this.currentDoc) return null;
    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }
    const docId = this.currentDoc.id;
    const snapshot = Y.encodeStateAsUpdate(this.ydoc);   // synchronous capture
    return persistSnapshot(docId, snapshot);
}
```

Step 2 - give `EditorInstance` an `onBeforeTeardown` prop and call it at the top
of `initializeEditor`, before `editor.destroy()`:

```ts
async function initializeEditor() {
    if (!element) return false;
    if (editor && ydoc && currentDocId) {
        onBeforeTeardown?.(currentDocId, ydoc);   // flush the doc we are leaving
    }
    if (editor) { editor.destroy(); editor = null; }
    ...
```

Step 3 - in `Editor.svelte`, wire it and delete `handleDocumentChange`,
`previousDocId` and the effect entirely:

```ts
function handleBeforeTeardown(docId: string, doc: Y.Doc) {
  void persistSnapshot(docId, Y.encodeStateAsUpdate(doc));
}
```

`saveService.setDocument(current)` already happens in `handleEditorReady`, which
fires on every rebuild, so nothing else needs the removed effect.

Step 4 - close the remaining windows. Add a flush on app teardown, since the
debounce timer is also lost when the window closes:

```ts
// Editor.svelte, onMount
const unlistenClose = await getCurrentWindow().onCloseRequested(() => {
  saveService?.flushNow();
});
```

and on `visibilitychange` to `hidden`, which is the mobile equivalent (Android
can kill a backgrounded app without a close event).

Step 5 - drop `debounceMs` from 1000 to 400. With flush-on-switch and
flush-on-hide in place the debounce only governs write amplification, and 400 ms
still coalesces normal typing.

**Tests.** `EditorSaveService` is currently untested. Add
`src/lib/editor/EditorSaveService.test.ts` covering: `flushNow` returns the
encoded snapshot for the document that was set, not a later one; `flushNow`
after `destroy()` is a no-op; `triggerSave` coalesces multiple calls into one
`persistSnapshot`. Mock `documentRepository` and `broadcastLocalUpdate`.

**Acceptance:** type in note A, click note B within 200 ms, click back to A. The
text is there. Repeat 10 times.

### 1.2 Deleting today's journal no longer bricks the editor pane

**File:** `src-tauri/src/commands/documents.rs`, `src/lib/sync/protocol.ts`,
`src/lib/sync/channel/DocSyncProtocol.ts`

**The bug.** Deletes are soft (`is_deleted = 1`) but journal ids are derived
from the date, so the tombstone keeps the primary key.
`get_or_create_today_journal` selects `WHERE is_deleted = 0` (miss) then
`INSERT`s the same id, which fails:

```
UNIQUE constraint failed: documents.id
```

That error propagates into `+page.svelte`'s `init()` catch, so
`setCurrentDocument` never runs and the editor pane sits on "Loading..."
indefinitely, on every launch. The same root cause makes calendar clicks on any
previously-deleted date do nothing, because `handleDateClick` only checks the
live list.

This splits into a shallow fix and a deeper one. Do both; the shallow one alone
creates a sync divergence.

#### 1.2a Revive the tombstone instead of colliding

In both `get_or_create_today_journal` and `create_document`, replace the bare
`INSERT` with an upsert:

```rust
db.execute(
    "INSERT INTO documents (id, type, title, created_at, updated_at, title_updated_at,
                            is_deleted, deleted_at, lifecycle_updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?4, 0, NULL, ?4)
     ON CONFLICT(id) DO UPDATE SET
         is_deleted           = 0,
         deleted_at           = NULL,
         updated_at           = excluded.updated_at,
         lifecycle_updated_at = excluded.lifecycle_updated_at",
    params![&doc_id, &doc_type, &title, now],
)?;
```

Deliberately do not overwrite `title` or `created_at` on conflict: the local row
is authoritative for those, and `apply_remote_rename` owns title convergence.

Also fix the check-then-insert race in `get_or_create_today_journal`, which
releases the mutex between the `SELECT` and the `INSERT`. Hold one lock across
both, or rely on the upsert being atomic and drop the pre-check.

Note this makes "delete today's journal" effectively mean "clear its content",
since `+page.svelte` calls `ensureTodayJournal()` on every launch. That is the
right behaviour for a journal app, but it should be a conscious decision.

#### 1.2b Make revival converge across devices

Reviving locally is not enough. The peer still holds `is_deleted = 1`, so the
next manifest exchange hits `reconcileEntry`:

```ts
if (entry.isDeleted) {
    if (!local || !local.isDeleted) await this.repo.applyDelete(...);
```

and re-deletes the journal you just revived. The deleted flag needs to be a
last-writer-wins register, exactly like `title` already is via
`title_updated_at`.

1. Migration v2 in `run_migrations`:

```rust
if version < 2 {
    db.execute_batch(
        "ALTER TABLE documents ADD COLUMN lifecycle_updated_at INTEGER;
         UPDATE documents SET lifecycle_updated_at =
             COALESCE(deleted_at, title_updated_at, updated_at)
           WHERE lifecycle_updated_at IS NULL;
         PRAGMA user_version = 2;",
    )?;
}
```

Guard it the same way v1 is guarded, so a fresh install whose base schema
already has the column does not fail. Add the column to
`setup_database_tables` too, and extend the existing `migration_tests` module
with a v1-to-v2 case.

2. `delete_document` and `apply_remote_delete` set `lifecycle_updated_at`
   alongside the flag. `apply_remote_delete` becomes conditional:

```rust
"UPDATE documents SET is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1
   WHERE id = ?2 AND (lifecycle_updated_at IS NULL OR lifecycle_updated_at < ?1)"
```

3. `DocSyncEntry` and `ManifestEntry` gain `lifecycleUpdatedAt: number`.
   `ADR 0007` dropped version negotiation on the grounds that all devices run the
   same build, so adding a field is acceptable, but read it defensively for one
   release: `entry.lifecycleUpdatedAt ?? entry.deletedAt ?? entry.createdAt`.

4. `reconcileEntry` compares stamps instead of branching on `isDeleted` alone:

```ts
const remoteStamp = entry.lifecycleUpdatedAt ?? entry.deletedAt ?? entry.createdAt;
const localStamp = local?.lifecycleUpdatedAt ?? local?.deletedAt ?? local?.createdAt ?? 0;

if (entry.isDeleted && remoteStamp > localStamp) {
  await this.repo.applyDelete(entry.id, entry.deletedAt ?? remoteStamp);
  return;
}
if (local?.isDeleted && localStamp >= remoteStamp) return; // our tombstone wins
```

5. `ensureDoc` -> `ensure_document` currently uses `INSERT OR IGNORE`, so a
   `doc-created` broadcast cannot clear a peer's tombstone. Give it the same
   `ON CONFLICT DO UPDATE` treatment, gated on the lifecycle stamp.

**Tests.** `DocSyncProtocol.test.ts` already has the harness. Add: a local
tombstone older than a remote revival is revived; a local revival newer than a
remote tombstone survives the exchange; two devices that delete and revive in
opposite orders converge on the same `is_deleted` value.

**Acceptance:** delete today's journal, restart, the app opens normally with a
fresh journal. On two paired devices, delete on A and revive on B; both settle
on revived.

---

## Phase 2 - Sync layer correctness

> **Status: done.** The drain backstop abandons the whole message rather than
> retrying per chunk; see the note in 2.2.

### 2.1 Attachment retry gives up

**File:** `src/lib/sync/channel/DocSyncProtocol.ts:143`

```js
const attempts = (this.attachInFlight.get(hash) ?? 0) + 1;
```

`armAttachTimeout` deletes the entry from `attachInFlight` before re-queueing, so
this lookup always misses and `attempts` recomputes as 1 forever.
`MAX_ATTACH_ATTEMPTS` is unreachable and a peer that never answers is polled
every 30 s for the life of the connection.

Carry the count on the queue entry, the way the document path already does with
`NeedItem`:

```ts
interface AttachItem { hash: string; attempts: number; }
private attachQueue: AttachItem[] = [];
private attachInFlight = new Map<string, AttachItem>();

private attachPump(): void {
    while (this.attachInFlight.size < MAX_ATTACH_IN_FLIGHT && this.attachQueue.length > 0) {
        const item = this.attachQueue.shift()!;
        item.attempts++;
        this.attachInFlight.set(item.hash, item);
        this.send({ t: 'attach-need', hash: item.hash });
        this.armAttachTimeout(item);
    }
}
```

Update `requestAttachment` and `onAttachManifest` to push `{ hash, attempts: 0 }`
and to dedupe on `.some(q => q.hash === hash)`.

**Test:** drive the protocol with a peer that never answers `attach-need`;
assert exactly `MAX_ATTACH_ATTEMPTS` sends, then silence.

### 2.2 Fix the two framing leaks

**File:** `src/lib/sync/channel/Framing.ts`

**`waitForDrain` can never settle.** It resolves only on `bufferedamountlow`. If
the channel closes mid-transfer that event never fires and the `send()` loop's
promise is orphaned:

```ts
function waitForDrain(): Promise<void> {
  if (channel.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      channel.removeEventListener('error', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, DRAIN_TIMEOUT_MS); // backstop, 30s
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
    channel.addEventListener('error', done);
  });
}
```

The existing `if (channel.readyState !== 'open') return;` after the await then
does the right thing.

**Partial messages are never reclaimed.** `inbox` entries for an aborted
transfer live until reload, and `frame.n` / `frame.i` are unvalidated so a
malformed peer frame drives `new Array(n)` directly. Add bounds and a sweep:

```ts
const MAX_CHUNKS = 4096; // 4096 * 16KB = 64MB ceiling per message
const REASSEMBLY_TIMEOUT_MS = 60_000;

if (frame.k === 1) {
  if (!Number.isInteger(frame.n) || frame.n <= 0 || frame.n > MAX_CHUNKS) {
    console.warn(`[sync/framing] rejecting begin frame with n=${frame.n}`);
    return;
  }
  inbox.set(frame.id, { parts: new Array(frame.n), got: 0, n: frame.n, startedAt: Date.now() });
  return;
}
// k === 2
const entry = inbox.get(frame.id);
if (!entry) return;
if (!Number.isInteger(frame.i) || frame.i < 0 || frame.i >= entry.n) return;
```

Sweep on a timer started by `attachFraming` and cleared by `detach()`, and have
`detach()` clear `inbox` outright.

**Test:** `Framing.test.ts` exists. Add: an oversized `n` is rejected; an
out-of-range `i` is ignored; a begin frame with no follow-up is evicted after the
timeout; `detach()` empties the inbox.

### 2.3 `save_pair` wipes `last_synchronized` on every reconnect

**File:** `src-tauri/src/pairing.rs:35`

`INSERT OR REPLACE` deletes the row and reinserts it, and `last_synchronized` is
not in the column list, so it resets to `NULL`. `transport.ts` calls `save_pair`
on every transition to `connected`, so the "last synced" display flickers to
never-synced on every reconnect until sync completes.

```rust
db.execute(
    "INSERT INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, peer_node_id) DO UPDATE SET
         peer_display_name = excluded.peer_display_name,
         room_id           = excluded.room_id",
    params![user_id, peer_node_id, peer_display_name, room_id],
)?;
```

### 2.4 `SignalingConfig` clobbers in-progress typing

**File:** `src/lib/settings/SignalingConfig.svelte:13`

The `$effect` resets `inputUrl` and `isEditing` whenever the `signalingUrl` prop
changes, discarding whatever the user is mid-way through typing. Seed the state
once and only resync when not editing:

```ts
$effect(() => {
  const incoming = signalingUrl;
  if (!isEditing) inputUrl = incoming ?? '';
});
```

This also clears the two outstanding `svelte-check` warnings at lines 10 and 11.

---

## Phase 3 - Quick security and durability wins

Small, independent, high value. Batch them into one change.

### 3.1 Scope the filesystem capabilities

**Files:** `src-tauri/capabilities/default.json`, `src-tauri/capabilities/mobile.json`

Both grant `fs:scope` of `{ "path": "**" }`, and `tauri.conf.json` sets
`assetProtocol.scope` to `["**"]`. The webview can read and write the entire
filesystem. Only the attachments directory is actually needed:

```json
{
  "identifier": "fs:scope",
  "allow": [{ "path": "$APPDATA/attachments/**" }]
}
```

and in `tauri.conf.json`:

```json
"assetProtocol": { "enable": true, "scope": ["$APPDATA/attachments/**"] }
```

This matters concretely: `save_attachment_bytes` accepts `image/svg+xml` from a
peer and `ext_for_mime` writes it as `.svg`, so a hostile peer's SVG rendered in
the webview would otherwise inherit full filesystem access.

Verify the `$HOME`, `$DOCUMENT` and `$DESKTOP` entries are genuinely unused
first: the only `fs` plugin consumers should be the image picker dialog. If the
picker does need broader read access, keep `fs:allow-read-file` scoped to the
dialog's returned path rather than a blanket glob.

While here, drop `image/svg+xml` from `ext_for_mime` and reject SVG attachments
outright. The editor only ever inserts raster images from the clipboard, file
picker or drag-drop, so SVG support is unused and is the one image type that can
carry script.

### 3.2 Clean up the CSP

**File:** `src-tauri/tauri.conf.json`

`connect-src` contains `ws://192.168.1.103:*`, a hardcoded LAN address shipped in
every build, alongside blanket `https://*` and `ws://*`. The webview talks to
exactly two things: Tauri IPC and WebRTC (which is not subject to `connect-src`).
The MQTT connection is made from Rust, not the webview. Reduce to:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data:; connect-src 'self' ipc: http://ipc.localhost
```

Test the dev server after this, since Vite HMR needs its own websocket during
`tauri dev`. If it breaks, gate the permissive entries behind a dev-only config
overlay rather than shipping them.

### 3.3 Set the SQLite pragmas

**File:** `src-tauri/src/db.rs`, in `AppState::new` right after `Connection::open`

No pragmas are set anywhere, which means `foreign_keys` is OFF and the
`ON DELETE CASCADE` on `yjs_updates` and `yjs_snapshots` has never fired.

```rust
conn.execute_batch(
    "PRAGMA journal_mode = WAL;
     PRAGMA synchronous = NORMAL;
     PRAGMA foreign_keys = ON;
     PRAGMA busy_timeout = 5000;",
)
.map_err(|e| e.to_string())?;
```

`foreign_keys = ON` changes behaviour: deleting a `documents` row now cascades.
Nothing hard-deletes documents today (`delete_document` is a soft delete that
calls `delete_document_data` explicitly), so this is safe, but confirm with a
test before enabling.

### 3.4 Add a release profile

**File:** `src-tauri/Cargo.toml`

There is no `[profile.release]` at all, so release builds use rustc defaults.

```toml
[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

`opt-level = "s"` is the right trade for an app that is IO-bound and shipped to
phones. Measure the APK before and after; expect a meaningful reduction.

---

## Phase 4 - Dead code removal

Do this before Phase 5. Removing the obsolete WebRTC stack shrinks the surface
that the signing work has to reason about, and several Phase 0.2 clippy warnings
live in files that disappear here.

### 4.1 Delete the obsolete Rust WebRTC and signaling stack

WebRTC moved to the frontend (`src/lib/sync/transport.ts`). These are vestigial:

- `src-tauri/src/network/webrtc_manager.rs` (120 lines)
- `src-tauri/src/network/peer_connection.rs` (119 lines)
- `src-tauri/src/network/signaling_client.rs` (96 lines)
- `src-tauri/src/network/peer_manager.rs` (46 lines)

Remove them, their `mod` declarations in `network/mod.rs`, and the
`webrtc_manager`, `peer_registry` and `signaling_client` fields from `AppState`.

`save_yjs_update` broadcasts into `webrtc_manager` on every save; that call goes
too (it is a no-op today but it awaits a lock).

### 4.2 Delete `spawn_sync_tasks`

**File:** `src-tauri/src/lib.rs:245`

It spawns a dedicated OS thread and a full tokio runtime whose only job is
forwarding `RtcEvent` and `PeerEvent` from the modules 4.1 deletes, ending in
`loop { sleep(60) }`. Delete the function and its call in `setup`.

Careful: it emits `sync-received`, which `Editor.svelte` listens for. That
listener is still needed, but its only real producer is the `sync-received` emit
inside `save_yjs_update` (see 6.1, which removes that one too). Sequence 4.2
before 6.1 and confirm the editor still refreshes on inbound peer updates.

### 4.3 Unregister the 25 unused Tauri commands

Of 62 registered commands, 25 are never invoked from the frontend:

```
get_all_documents_full   search_documents        get_backlinks
get_journals             get_signaling_url       save_signaling_url
delete_image             get_attachment_path     list_pending_attachments
get_all_attachment_hashes load_document          set_display_name
get_node_id              get_user_id             derive_room_id
trigger_sync             create_snapshot         get_all_updates
get_signaling_status     get_sync_peers          add_sync_peer
remove_sync_peer         set_sync_enabled        mqtt_disconnect
get_mqtt_status
```

Three of these are wanted, not dead, and should be wired up rather than removed
(see Phase 7): `set_display_name` (7.2), `search_documents` (7.3), and
`get_backlinks` (7.1, needs a real implementation first). `mqtt_disconnect` is
worth keeping and wiring to a "Disconnect" control in the sync settings.

Delete the rest, including the `sync_peers` table and `peer_manager.rs` from 4.1,
which only that dead path used.

Regenerate the command list and re-run `npm run check` to catch any `invoke`
call the grep missed.

### 4.4 Delete the dead Svelte components

- `src/lib/settings/PeerList.svelte` (140 lines)
- `src/lib/settings/AddPeerForm.svelte` (88 lines)
- `src/lib/settings/SyncControls.svelte` (169 lines)

None are imported anywhere. They are superseded by `ConnectedPeerList` and
`PairDeviceForm`. They are not exported from `settings/index.ts` either, which is
how they went unnoticed.

### 4.5 Collapse `YjsEditorExtension.ts`

The `YjsEditorExtension` itself is a no-op (`addProseMirrorPlugins` returns
`[]`) and is never imported. `exportYjsDocSnapshot`, `exportYjsDocUpdate`,
`applyYjsUpdate` and `isEmptyContent` are unused.

Keep only `loadYjsDocFromState`, `createInitialContent` and
`createCollaborationExtension`, and move them into
`src/lib/editor/yjs.ts` next to their only consumer, `EditorInstance.svelte`.
Delete `src/lib/yjs/`.

### 4.6 Remove unused Cargo dependencies and deduplicate `derive_room_id`

Seven dependencies have zero references in `src-tauri/src`:

```
walkdir  regex  ignore  glob  http  bincode  futures-lite
```

`regex`, `ignore` and `walkdir` in particular are a meaningful compile-time and
binary-size cost. Remove all seven and confirm with `cargo build`.

`derive_room_id` is implemented three times with identical semantics:

- `src-tauri/src/network/signaling_manager.rs:376`
- `src-tauri/src/pairing.rs:128`
- `calculateRoomId` in `src/lib/sync/transport.ts:196`

Keep `pairing::derive_room_id` as the single Rust implementation and have
`signaling_manager` call it. The TypeScript copy has to stay (it runs in the
webview during pairing), so add a comment on each pointing at the other and a
test asserting both produce the same digest for a known input pair.

---

## Phase 5 - Authenticated signaling

The largest item, and the only one that changes the threat model.

### 5.1 The problem

Device identity is a bare random UUID (`identity.rs`) with no key material. The
signaling envelope's `from` field is set by the publisher and never verified.
`handle_offer` trusts `msg.from` against the `device_pairs` table
(`signaling_manager.rs:236`), so anyone who can publish to the broker can forge
`from` as one of your paired node ids and get a full read-write document sync
session.

The two UUIDs needed are both transmitted in cleartext during pairing, the
shipped broker is `allow_anonymous true` with no ACLs
(`mosquitto/config/mosquitto.conf`), and the client cannot do TLS at all:
`mqtts://host:8883` falls through the `rfind(':')` branch in
`mqtt_client.rs:57` and produces the host `"mqtts://host"`.

### 5.2 Design

Make `node_id` the device's Ed25519 public key and sign every signaling message.

- Keypair generated once per device via `ed25519-dalek` v2, stored in the
  `identity` table alongside the existing rows.
- `node_id` becomes base64url-unpadded of the 32-byte public key, 43 characters.
  The base64url alphabet (`A-Za-z0-9-_`) contains no MQTT wildcard or separator
  characters, so it is safe in a topic segment, and 43 characters fits a QR code
  more comfortably than the current 36-character UUID.
- The envelope gains `ts`, `nonce` and `sig`:

```rust
pub struct SignalingMessage {
    pub from: String,           // base64url(pubkey)
    pub to: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: String,
    pub ts: i64,                // unix millis
    pub nonce: String,          // base64url(16 random bytes)
    pub sig: String,            // base64url(Ed25519 over the canonical bytes)
}
```

- Signed bytes are a length-prefixed concatenation of
  `from | to | msg_type | payload | ts | nonce`. Length-prefix each field rather
  than joining with a separator, so a value containing the separator cannot be
  used to shift field boundaries.
- Verification, before any existing trust check:
  1. decode `from` as a public key, reject if malformed;
  2. verify `sig`, reject on failure;
  3. reject if `ts` is outside a +/-120 s window;
  4. reject if `(from, nonce)` is in a bounded LRU of recently seen values.
- `offer`, `answer` and `ice-candidate` additionally keep the existing
  `device_pairs` / `authorized_peers` check. Signature verification proves who
  sent it; the pair table decides whether we care.

Storing the private key in SQLite in the app data directory puts it at exactly
the same protection level as the notes it protects, which is coherent. Moving it
to the OS keychain is a worthwhile follow-up but is a separate, platform-heavy
piece of work; note it in the ADR rather than blocking on it.

### 5.3 Migration

`node_id` changes meaning, so existing pairs break. Given `0.0.x-alpha` and the
README's "IT IS NOT STABLE YET", requiring a one-time re-pair is the right call
over a dual-stack grace period.

Migration v3: add `public_key` and `secret_key` columns to `identity`, generate a
keypair, set `node_id` to the new encoding, and `DELETE FROM device_pairs`. On
first launch after upgrade, show a one-time notice in the sync settings
explaining that devices must be re-paired, with a link to the new node id.

### 5.4 MQTT transport hardening

- Parse `mqtts://` and `ssl://` in `MqttSignalingClient::new`, default port 8883,
  and set `Transport::Tls` with the platform root store. Add the `use-rustls`
  feature to `rumqttc` and `rustls-native-certs`. Reject a URL with an
  unrecognised scheme with a clear error instead of silently producing a bad
  host.
- Fix the existing parse bug regardless: `url.starts_with("mqtt://")` does not
  match `mqtts://`, so the current code mangles it.
- Update `docker-compose.yml` and `mosquitto.conf` for the reference broker:
  `allow_anonymous false`, a password file, a TLS listener on 8883, and a
  per-client ACL restricting each device to `signaling/<its own node_id>/#` for
  subscribe and publish. Document generating credentials in `DEVELOPMENT.md`.
- Signature verification makes the broker untrusted-by-design, so broker ACLs
  become defence in depth rather than the only control. Both are worth having.

### 5.5 Write the ADR and tests

Add `docs/decisions/0008-authenticated-signaling.md` in the existing format,
covering: why UUID identity was insufficient, the signed-envelope design, why
re-pairing rather than a compatibility window, and the deferred keychain work.

Tests in `signaling_manager.rs`:

- a valid signature from a paired peer is accepted;
- a valid signature from an unpaired peer is rejected at the pair check;
- a message whose `from` does not match the signing key is rejected;
- a replayed `(from, nonce)` is rejected;
- a message with `ts` two hours old is rejected;
- a payload mutated after signing is rejected.

---

## Phase 6 - Performance

### 6.1 Stop the self-inflicted reload on every save

This is the largest single win and it is nearly free.

`save_yjs_update` (`commands/sync.rs`) emits `sync-received` with the doc id on
every local save, as a "local echo". `Editor.svelte`'s listener sees the id match
the open document and calls `reloadCurrentDocument()`, which fetches the entire
document state over IPC and applies it back into the ydoc that just produced it.

So every debounced save triggers a full round trip of the whole document plus a
redundant `Y.applyUpdate`. It is idempotent in Yjs terms, so nothing corrupts,
but it is pure waste and it scales with document size.

Fix: stop emitting the local echo. Inbound peer updates already reach the editor
through `DocumentRepository.mergeDelta`, which invokes `save_yjs_update` on the
receiving side. Distinguish the two by adding an `origin` parameter:

```rust
pub async fn save_yjs_update(..., origin: Option<String>) -> Result<(), String> {
    ...
    if origin.as_deref() == Some("remote") {
        let _ = state.app_handle.emit("sync-received", json!({ "doc_id": doc_id }));
    }
}
```

`saveLocalUpdate` passes `"local"`, `mergeDelta` passes `"remote"`. Verify with
the console open that typing produces no `get_yjs_state` calls.

### 6.2 Broadcast deltas, not whole documents

`EditorSaveService.performSave` sends `Y.encodeStateAsUpdate(ydoc)` (the entire
document) to every peer on every save, and `mergeDelta` on the receiving side
loads, applies, re-encodes and re-hashes the whole document to absorb it.

Switch the live path to incremental updates:

```ts
// EditorInstance, after creating the ydoc
newYDoc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin === REMOTE_ORIGIN) return; // do not echo peer updates back
  onLocalUpdate?.(update);
});
```

Accumulate those into a pending buffer, and on the debounce tick send
`Y.mergeUpdates(pending)` as the `live-update` payload instead of the full state.
`mergeDelta` already handles arbitrary updates correctly, so the receiving side
needs no change.

The full-state path stays for persistence (`crdt_state` is a materialized column)
and for the manifest/delta reconciliation on connect, which is what guarantees
correctness. This only changes the steady-state optimisation.

Tag remote applications with a distinct origin in `mergeDelta` so the filter
above works.

### 6.3 Stop sending Yjs state as a JSON number array

`DocumentRepository` passes `Array.from(mergedState)` across the IPC boundary,
which inflates each byte to roughly 4 to 6 characters of JSON. `get_yjs_state`
returns `Vec<u8>` the same way.

Switch both directions to base64 strings (the `base64` crate is already a
dependency and `bytesToBase64` already exists in `protocol.ts`), taking the
overhead from roughly 400% to 33%:

```rust
pub async fn save_yjs_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: String,          // base64
    merged_state: String,    // base64
    content_hash: Option<String>,
) -> Result<(), String> {
    let update = BASE64.decode(&update).map_err(|e| e.to_string())?;
    ...
```

For the read direction, `tauri::ipc::Response::new(Vec<u8>)` returns a raw
ArrayBuffer with no encoding overhead at all and is worth using for
`get_yjs_state` specifically, since that is the hot read path.

Do 6.3 after 6.1 and 6.2, which between them remove most of the traffic that
makes the encoding matter.

### 6.4 Reduce logging in release builds

109 `console.*` calls in `src` and 71 `eprintln!` in `src-tauri/src`, several
logging node ids and full SDP payloads. After Phase 5 those become key material.

- Frontend: add a small `src/lib/log.ts` wrapper that no-ops below a level set
  from `import.meta.env.DEV`, and replace the `console.*` calls. Keep
  `console.error`.
- Rust: replace `eprintln!` with the `log` crate plus `tauri-plugin-log`, at
  `debug` for the chatty paths and `warn`/`error` for real problems.
- Audit what remains for anything that prints a node id, user id, SDP or
  secret key.

---

## Phase 7 - Feature gaps and docs

### 7.1 `get_backlinks` ignores its argument

**File:** `src-tauri/src/commands/documents.rs:409`

The parameter is `_target_title` and the query has no filter, so it returns every
non-deleted document. It is a stub in the shape of an implementation, and the
README advertises it as a feature.

Backlinks need an edge table, since link structure lives inside the CRDT and is
not queryable from SQL:

```sql
CREATE TABLE IF NOT EXISTS document_links (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY (source_id) REFERENCES documents(id) ON DELETE CASCADE
);
```

Populate it from the frontend, which is where the ProseMirror document is
available: on save, walk the doc for `DocumentLinkNode` nodes, collect target
ids, and send the set to a `set_document_links(doc_id, target_ids)` command that
replaces that source's rows in one transaction. Then `get_backlinks` becomes a
real join on `target_id`.

Add a backlinks panel in the editor, or defer the UI and just fix the command
plus wire it behind the existing document-link hover. Decide which before
starting; the table and the command are worth having either way.

### 7.2 Let the user rename their device

`set_display_name` exists in Rust but has no UI. On Android `hostname()` returns
`localhost`, so `default_display_name` falls back to `Device-a1b2c3d4`
(`identity.rs:34`). That opaque string is what every paired device shows,
permanently.

Add an editable field to `IdentityCard.svelte` next to the device name, calling
`set_display_name` then `get_identity` to refresh the store. Propagate the change
to connected peers: the display name already travels in the pair payload and in
the offer envelope, so the simplest path is a new `peer-renamed` sync message
that updates `device_pairs.peer_display_name` on the far side, falling back to
the next reconnect if the peer is offline.

### 7.3 Make search useful

`Sidebar.svelte:43` filters note titles client-side with
`title.toLowerCase().includes(query)`, skipping journals entirely.
`search_documents` exists in Rust but is unused, and also only searches titles.

Two steps:

1. Cheap: include journals in the client-side filter and show the two groups
   separately in the results. One-line change, removes the surprise that
   searching never finds a journal entry.
2. Real: content search needs the document text in SQL. Add an FTS5 virtual
   table and populate it from the frontend on save with
   `editor.getText()`, alongside the `document_links` write from 7.1 (same hook,
   same transaction). Then `search_documents` can return real snippets and the
   `line_content` field it already declares but always leaves empty becomes
   meaningful.

### 7.4 Fix the README

It advertises two features that are not implemented:

- "Task Lists: List out all of your TODO list in one place" - `indexer.rs`
  hardcodes `todo_count = 0` and `completed_todo_count = 0`, and nothing counts
  them. Either implement the count in the same save-time hook as 7.1 and 7.3, or
  remove the claim.
- "Document Linking: Track and index your linked notes" - covered by 7.1.

It also never mentions peer-to-peer sync, which is the app's largest subsystem
and the thing `docs/decisions/` is almost entirely about. Add a Sync section
describing the pairing flow, the broker requirement, and after Phase 5, the
security model.

### 7.5 Tidy `docker-compose.yml`

The top-level `volumes:` block declares `mosquitto_data` and `mosquitto_logs`,
neither of which is referenced; the service uses bind mounts. Remove the block.

---

## Suggested sequencing

Phases 0 through 3 are each small enough to be one PR. Phase 4 should be one PR
per numbered item so a regression is easy to bisect. Phase 5 wants its own
branch and its ADR written before the code. Phases 6 and 7 are independent of
each other and can interleave.

A reasonable first pass, if the whole plan is too much at once:

1. Phase 0 (CI) - protects everything else.
2. 1.1 and 1.2 - the two bugs users hit today.
3. 3.1, 3.2, 3.3 - an afternoon, removes the worst of the blast radius.
4. 6.1 - one-line change, largest performance win in the app.

That is roughly a day and a half and covers the findings with real user impact.
