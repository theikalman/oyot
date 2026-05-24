# Implementation Plan: Loro → Yjs Architecture Migration

## Key Decisions

- **Clean slate**: Existing Loro data is discarded. No migration code.
- **Simplified metadata**: Drop `document_index` table and todo counts entirely. Frontend passes `title` string alongside each update commit.
- **Tiptap Collaboration ext**: Use `@tiptap/extension-collaboration` with a local `Y.Doc` (no network provider wrapper).

---

## Phase 1 — Database Schema Overhaul

**File:** `src-tauri/src/lib.rs` → `setup_database_tables()`

Replace the existing schema with:

```sql
-- Drop crdt_state from documents; remove document_index entirely
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL CHECK(type IN ('journal', 'note')),
    title       TEXT    NOT NULL DEFAULT 'Untitled',
    is_deleted  INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- New append-only Yjs update log
CREATE TABLE IF NOT EXISTS document_updates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id          TEXT    NOT NULL,
    update_blob     BLOB    NOT NULL,
    timestamp       INTEGER NOT NULL,
    origin_peer_id  TEXT               -- NULL = local, node_id string = remote peer
);
CREATE INDEX IF NOT EXISTS idx_doc_updates_doc_id
    ON document_updates (doc_id, id ASC);

-- attachments and sync_peers unchanged
```

Because this is a clean-slate migration, on first launch the old tables are simply not recreated (the new `CREATE TABLE IF NOT EXISTS` schema takes over on a fresh DB, or the user's old `oyot.db` is replaced).

---

## Phase 2 — Remove Rust CRDT Layer

### Files to delete

| File | Reason |
|---|---|
| `src-tauri/src/crdt.rs` | Entire Loro CRDT wrapper — no longer needed |
| `src-tauri/src/indexer.rs` | Used Loro to extract title/todos — replaced by frontend passing title directly |

### `src-tauri/Cargo.toml`

- Remove `loro = "1.0"` dependency.

### `src-tauri/src/lib.rs`

- Remove `mod crdt;` and `mod indexer;` declarations.
- Replace `apply_crdt_delta()` with a new `store_remote_update()` function that simply does:
  ```rust
  INSERT INTO document_updates (doc_id, update_blob, timestamp, origin_peer_id) VALUES (?, ?, ?, ?)
  UPDATE documents SET updated_at = ? WHERE id = ?
  ```
- Update `handle_doc_request()` to read from `document_updates` instead of `crdt_state`.

---

## Phase 3 — New & Updated Rust IPC Commands

### New commands (add to `src-tauri/src/commands/sync.rs`)

#### `load_document_ledger(doc_id) → Vec<Vec<u8>>`

```sql
SELECT update_blob FROM document_updates
WHERE doc_id = ? ORDER BY id ASC
```

Returns all Yjs update blobs in insertion order for hydration.

#### `commit_local_update(doc_id, update_blob: Vec<u8>, title: String) → ()`

```sql
INSERT INTO document_updates (doc_id, update_blob, timestamp, origin_peer_id) VALUES (?, ?, ?, NULL)
UPDATE documents SET title = ?, updated_at = ? WHERE id = ?
```

Persists one Yjs binary update chunk and updates the title.

#### `broadcast_p2p_update(doc_id, update_blob: Vec<u8>) → ()`

Calls `gossip_broadcaster.broadcast(SyncMessage::SendDocDelta { doc_id, delta: update_blob })` — no DB write, pure network push.

### Commands to remove

- `get_crdt_state` — replaced by `load_document_ledger`
- `save_crdt_update` — replaced by `commit_local_update` + `broadcast_p2p_update`
- `export_document_update_since` — Yjs manages its own sync vectors in JS

### Update `src-tauri/src/commands/documents.rs`

- Remove `crdt_state` field from `Document` struct and all queries (`SELECT`, `INSERT`, `UPDATE`).
- `create_document` — no longer initializes a Loro snapshot; inserts empty doc with title only.
- `get_all_documents` — no longer `JOIN document_index`; select from `documents` directly.
- `get_document` — no longer returns `crdt_state`; returns metadata only.
- `update_document` — title and `updated_at` only.
- Remove `get_backlinks` (or stub it out — it was already returning all docs).

### Register new commands in `src-tauri/src/lib.rs` invoke handler

Replace `get_crdt_state`, `save_crdt_update`, `export_document_update_since` with `load_document_ledger`, `commit_local_update`, `broadcast_p2p_update`.

---

## Phase 4 — Sync Protocol Update

**File:** `src-tauri/src/network/sync_protocol.rs`

Add a new variant for bulk updates (used during catch-up QUIC sync):

```rust
enum SyncMessage {
    // ... existing variants ...
    SendDocDelta { doc_id: String, delta: Vec<u8> },          // gossip: single live update
    SendDocUpdates { doc_id: String, updates: Vec<Vec<u8>> }, // QUIC: all updates (catch-up)
    // ... rest unchanged ...
}
```

**`handle_doc_request()` in `lib.rs`** — instead of reading `crdt_state`, reads all update blobs:

```sql
SELECT update_blob FROM document_updates WHERE doc_id = ? ORDER BY id ASC
```

Sends as `SyncMessage::SendDocUpdates { doc_id, updates }`.

**`handle_gossip_messages()` / `process_gossip_message()` in `lib.rs`** — On `SendDocDelta` received, call `store_remote_update()` (INSERT into `document_updates`) then:

```rust
app_handle.emit("remote_network_update", { doc_id, update_blob })
```

The Tauri event name changes from `sync-received` → `remote_network_update` to match the sequence diagram.

---

## Phase 5 — Frontend Dependencies

### `package.json`

| Action | Package |
|---|---|
| Remove | `loro-crdt`, `loro-prosemirror`, `loro-wasm` |
| Remove | `vite-plugin-wasm`, `vite-plugin-top-level-await` |
| Add | `yjs` |

`@tiptap/extension-collaboration` is already installed — no change needed.

### `vite.config.js`

Remove the WASM plugins (`wasm()`, `topLevelAwait()`).

---

## Phase 6 — Remove Loro Frontend Layer, Add Yjs Utilities

### Delete

- `src/lib/loro/` (entire directory: `LoroEditorExtension.ts`, `lazyLoader.ts`, `loroApp.ts`, `tiptapBinding.ts`)

### Create `src/lib/yjs/yjsApp.ts`

Exports:

```ts
// Create a fresh Yjs doc
createYjsDoc(): Y.Doc

// Load from an array of raw update blobs (from load_document_ledger)
loadYjsDocFromUpdates(updates: Uint8Array[]): Y.Doc

// Encode current state as a single update blob (for initial doc creation)
encodeYjsState(ydoc: Y.Doc): Uint8Array
```

No provider, no network — just pure `Y.Doc` operations used by the editor.

---

## Phase 7 — Editor Refactor

### `src/lib/editor/EditorInstance.svelte`

**Old initialization flow:**

```
loadLoroDocFromState(doc.crdt_state)
→ new Editor({ extensions: [..., noLoro] })
→ addLoroPluginsToEditor(editor, loroDoc)
```

**New initialization flow:**

```
invoke('load_document_ledger', { docId: doc.id }) → Vec<Uint8Array>
→ ydoc = loadYjsDocFromUpdates(blobs)
→ new Editor({
    extensions: [
      ...,
      Collaboration.configure({ document: ydoc })
    ]
  })
```

Specific changes:

- Replace `loroDoc` state variable with `ydoc: Y.Doc | null`
- Remove all `loro-crdt` imports; import from `$lib/yjs/yjsApp`
- Remove `addLoroPluginsToEditor`, `createPresenceStore` calls
- Add `Collaboration` to editor extensions list
- Props: `document` type no longer includes `crdt_state`
- The `onEditorReady` callback signature changes: `(editor, ydoc)` instead of `(editor, loroDoc)`

### `src/lib/editor/EditorSaveService.ts`

**Old approach:** Debounce timer → `exportLoroDocSnapshot()` → single `save_crdt_update` call.

**New approach:** Event-driven — listen to `ydoc.on('update', handler)` in the editor, pass raw update blobs directly. Two parallel IPC calls per update:

```ts
// On ydoc 'update' event (called with the binary update chunk):
async handleYjsUpdate(updateBlob: Uint8Array, title: string) {
    await Promise.all([
        invoke('commit_local_update', { docId, updateBlob: Array.from(updateBlob), title }),
        invoke('broadcast_p2p_update', { docId, updateBlob: Array.from(updateBlob) })
    ])
}
```

The save service is simplified — no debounce needed for DB write (each update is small and idempotent); debounce can still be applied for the title update if desired.

Replace `setLoroDoc()` with `setYjsDoc(ydoc: Y.Doc)`. Keep `setDocument()` unchanged.

---

## Phase 8 — TypeScript Types & Stores

### `src/lib/types.ts`

```ts
// Remove: crdt_state field from Document
// Remove: todo_count, completed_todo_count from DocumentSummary
// Remove: IndexData type (was just { documents: DocumentSummary[] })

interface Document {
    id: string;
    doc_type: 'journal' | 'note';
    title: string;
    created_at: number;
    updated_at: number;
    // crdt_state REMOVED
}

interface DocumentSummary {
    id: string;
    doc_type: 'journal' | 'note';
    title: string;
    created_at: number;
    updated_at: number;
    // todo_count, completed_todo_count REMOVED
}
```

### `src/lib/stores/app.ts`

- Update `appStore` state type to use new `Document`/`DocumentSummary` definitions.
- Remove `isLoading` todo-count-related derived store if any.

### `src/lib/services/documents.ts`

- `loadDocument()` — returns `Document` without `crdt_state`
- `saveCrdtUpdate()` — remove; replaced by `commitLocalUpdate()` and `broadcastP2PUpdate()`
- Add `loadDocumentLedger(docId): Promise<Uint8Array[]>` — calls `invoke('load_document_ledger')`, converts `number[][]` to `Uint8Array[]`

### `src/lib/services/sync.ts`

- Replace `sync-received` event listener with `remote_network_update` listener.
- On `remote_network_update`: call a new `applyRemoteUpdate(docId, updateBlob)` function that applies to the active Yjs doc via a store/callback.

### `src/routes/+page.svelte`

- Pass `document` (without `crdt_state`) to `<Editor />`.
- Remove any imports/usage of `cleanupOrphanedImages` if it depended on CRDT state (it doesn't — it's image-only; keep it).

---

## Phase 9 — Sidebar Simplification

With `document_index` removed and todo counts gone, the `<Sidebar>` component:

- Simply lists documents from `documents` store (title + date).
- Remove any todo-count badges/indicators from `Sidebar.svelte` and `DocumentSummary` display code.

---

## File-Level Change Summary

| File | Action | Notes |
|---|---|---|
| `src-tauri/src/crdt.rs` | **Delete** | Loro wrapper gone |
| `src-tauri/src/indexer.rs` | **Delete** | Loro metadata extractor gone |
| `src/lib/loro/` (4 files) | **Delete** | Entire Loro frontend layer |
| `src/lib/yjs/yjsApp.ts` | **Create** | Yjs doc creation and hydration utilities |
| `src-tauri/src/lib.rs` | **Heavily modify** | Schema, remove CRDT, update gossip/QUIC handlers |
| `src-tauri/src/commands/sync.rs` | **Heavily modify** | 3 new commands, 3 old CRDT commands removed |
| `src-tauri/src/commands/documents.rs` | **Modify** | Remove `crdt_state` everywhere |
| `src-tauri/src/network/sync_protocol.rs` | **Modify** | Add `SendDocUpdates` variant |
| `src-tauri/Cargo.toml` | **Modify** | Remove `loro` crate |
| `src/lib/editor/EditorInstance.svelte` | **Heavily modify** | Yjs init, Collaboration extension |
| `src/lib/editor/EditorSaveService.ts` | **Rewrite** | Event-driven Yjs update saving |
| `src/lib/types.ts` | **Modify** | Remove `crdt_state`, todo counts |
| `src/lib/stores/app.ts` | **Modify** | Updated types |
| `src/lib/services/documents.ts` | **Modify** | New `loadDocumentLedger` + updated service calls |
| `src/lib/services/sync.ts` | **Modify** | New event name, Yjs apply callback |
| `src/lib/components/Sidebar.svelte` | **Modify** | Remove todo count display |
| `package.json` | **Modify** | Remove Loro deps, add `yjs` |
| `vite.config.js` | **Modify** | Remove WASM plugins |
| `src/routes/+page.svelte` | **Minor modify** | Updated document type passing |

---

## Execution Order

1. **DB schema** (`lib.rs` → `setup_database_tables`) — foundation everything else builds on
2. **Rust dep removal** (`Cargo.toml`, delete `crdt.rs` + `indexer.rs`)
3. **New Rust commands** (`commands/sync.rs`, `commands/documents.rs`, `lib.rs` sync handlers)
4. **Wire protocol** (`network/sync_protocol.rs`)
5. **JS deps + vite config** (`package.json`, `vite.config.js`)
6. **Yjs utility layer** (`src/lib/yjs/yjsApp.ts`)
7. **Types + stores + services** (`types.ts`, `stores/app.ts`, `services/`)
8. **Editor refactor** (`EditorInstance.svelte`, `EditorSaveService.ts`)
9. **UI cleanup** (`Sidebar.svelte`, `+page.svelte`)
10. **Build & verify** — `cargo check` + `npm run check` + full app launch test
