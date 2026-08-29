# 0005: Sync image attachments as content-addressed blobs alongside the CRDT

- **Status:** Accepted
- **Date:** 2026-08-29
- **Extends:** [0003](0003-full-document-set-sync.md) (decision 6 assumed images
  ride inside the Yjs document as base64; they do not)

## Context

Images are not embedded in the document. Inserting one calls `save_image`, which
writes the bytes to `app_data_dir/attachments/<sha256>.<ext>` and records a row
in the `attachments` table. Only a reference goes into the Yjs document.

Two defects made a synced image fail to load on the receiving device:

1. **The reference was device-local.** `insertImageNode` stored
   `convertFileSrc(<absolute local path>)` as the image `src` - e.g.
   `http://asset.localhost/data/user/0/com.ajiyakin.oyot/attachments/<hash>.png`
   on Android. That string is meaningless on any other device, and the image
   node view assigned it to `<img src>` verbatim. (Regression from the commit
   that moved images to Tauri's asset protocol.)

2. **The bytes never travelled.** `DocSyncProtocol` reconciles Yjs documents
   only. There was no manifest, request, or transfer for attachment binaries -
   and no code path consumed the half-built Rust scaffolding
   (`is_fully_downloaded`, `request_attachment`, `list_pending_attachments`).

## Decision

**1. Store a portable reference, resolve it at render time.** The document holds
`oyot-attachment://<hash>` (and `alt="oyot:<hash>"`). The image node view
(`ResizableImage`) derives the hash and resolves it to a loadable
`asset:`/`http://asset.localhost` URL via `get_local_blob_url` +
`convertFileSrc`. While the bytes are absent it shows a 1x1 placeholder (no
failed request in the console) and re-resolves when they arrive. The raw
`oyot-attachment://` scheme is never assigned to `<img src>`, so no custom URI
scheme or CSP entry is needed.

**2. Migrate legacy baked references in place.** On editor create, image nodes
whose `src` is a non-scheme, non-`data:` URL are rewritten to
`oyot-attachment://<hash>` - the hash recovered from `alt="oyot:<hash>"` or from
the `<hash>` in the old path. The rewrite is a normal (non-undoable) transaction,
so the fix propagates to paired devices on the next sync. Resolution also
accepts the legacy forms directly, so an un-migrated node still renders.

**3. Reconcile attachments over the data channel, mirroring the document
protocol.** Protocol version bumps to **3**. New messages:

| message | meaning |
|---|---|
| `attach-manifest` | every attachment the sender holds in full `{hash, mime, size}` |
| `attach-need` | receiver requests one hash |
| `attach-data` | holder replies with base64 bytes (framing layer chunks it) |
| `attach-missing` | holder no longer has the bytes; stop asking |

Each peer sends `attach-manifest` on connect (right after `sync-manifest`) and
again as a one-item list when a new image is inserted locally
(`broadcastAttachmentAvailable`). The receiver pulls any hash it lacks. The
image node view also calls `pullAttachmentFromPeers(hash)` when it renders a
missing reference, covering the case where the document arrives before the
manifest.

**4. Attachments run off the document finish gate.** They have their own bounded
queue (`MAX_ATTACH_IN_FLIGHT = 2`, 30s timeout, 2 attempts) and do not count
toward `onSynced`. A large image never blocks "text is synced", and a peer that
cannot serve a blob just delays that one image.

**5. The hash is the integrity check.** `save_attachment_bytes` recomputes the
SHA-256 and rejects a mismatch, then emits `attachment-downloaded` so open
editors re-resolve.

## Alternatives considered

**Register an `oyot-attachment://` URI scheme in Rust** that streams the file so
`<img src>` can stay the scheme string. Cleaner in the document, but adds a
cross-platform surface (Android rewrites custom schemes), a CSP entry, and a
placeholder-vs-404 decision in Rust. Node-view resolution keeps everything on
the already-working asset protocol.

**Embed images as base64 in the Yjs document** (what ADR 0003 assumed). Every
device already has the framing layer to move a multi-MB message, but it also
means the image bytes live in CRDT history forever, re-encode on every
`encodeStateAsUpdate`, and inflate every manifest hash exchange. Content-
addressed blobs kept outside the CRDT are cheaper and already how storage works.

**Fetch attachments through the MQTT broker / a relay.** Defeats the point of a
device-to-device app and puts image bytes on a third party. The data channel is
already open and authenticated by the pairing.

**Push every attachment a peer lacks, referenced or not.** Simple, but resurrects
blobs for images that were deleted from the text. We advertise only
`is_fully_downloaded` rows and rely on the existing `cleanup_orphaned_images`
pass; a reference scan can be added later if bandwidth becomes a concern.

## Consequences

- A v2 peer never sends `attach-manifest`, so it silently transfers no images.
  The `hello` version mismatch already surfaces it as "needs updating"; both
  ends are the same user's devices, so this converges on the next update.
- The first render of a just-synced image shows a placeholder for as long as the
  transfer takes (seconds for a photo over a direct connection). The node view
  swaps in the real bytes on `attachment-downloaded` without a document reload.
- Attachment transfer is best-effort per connection: after 2 failed attempts the
  image is dropped until the next reconnect re-advertises it. Same shape as the
  document `sync-need` give-up.
- `attachments` rows with `is_fully_downloaded = 0` are now meaningful - they are
  what the node view and the sync layer treat as "pull this".
