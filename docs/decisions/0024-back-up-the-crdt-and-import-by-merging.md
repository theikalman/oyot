# 0024: Back up the CRDT itself, and import a backup by merging it like a peer

- **Status:** Proposed
- **Date:** 2026-09-23
- **Extends:** [0003](0003-full-document-set-sync.md), [0008](0008-deletion-as-last-writer-wins.md), [0014](0014-the-merged-blob-is-the-only-content-store.md), [0021](0021-export-notes-as-a-markdown-archive.md)

## Context

Every copy of a note lives on the user's own devices. Sync keeps those copies
in step, which protects against losing one device, but not against losing all
of them, and not against setting a device up again from nothing when there is
no peer left to sync from. There was no way to put the library somewhere else
and bring it back.

The Markdown export (ADR 0021) is not that. It is lossy on purpose: image
widths, column widths and the CRDT itself are gone. A note read back from it
would be a new document with a new history, and merging it with a surviving
copy of the same note would duplicate every paragraph instead of converging.

Three things shaped the answer.

The content store is already a merge format. A note is a Yjs state in
`documents.crdt_state` (ADR 0014), and the metadata around it - the title
stamp, the lifecycle stamp, the tombstone - is exactly what the sync manifest
carries. Applying a whole Yjs state to a document that already holds part of it
is how a peer's content arrives today.

Merging needs the webview. Rust holds the bytes but cannot read them. The
merge, the open-document registry (ADR 0010) and the derived rows (ADR 0013)
all live on the frontend, behind `DocumentRepository`.

Anything read back in is untrusted. The user chooses the file, but it may have
been downloaded, edited or crafted, and the code that reads it writes to the
library.

## Decision

**1. A backup is the CRDT, not a rendering of it.** A zip named
`oyot-backup-YYYY-MM-DD-HHmm.zip`, holding:

```
manifest.json         format, formatVersion, encryption, appVersion, createdAt,
                      the source device's name, counts, and
                      { path, size, sha256 } for every other entry
documents.json        one row per document: id, docType, title, createdAt,
                      updatedAt, titleUpdatedAt, isDeleted, deletedAt,
                      lifecycleUpdatedAt, and the entry holding its state
                      (null for a tombstone)
documents/NNNNNN.yjs  the raw crdt_state
attachments/<hash>.<ext>
preferences.json      the theme, and whatever joins it in config.json
```

State entries are numbered rather than named after the document id, because a
journal's id is its date, spaces included, and an entry name should not be
something to argue about. A state entry's checksum in the manifest is the
SHA-256 of the state, which is exactly the sync layer's content hash, so the
document row does not carry a second copy of it that could disagree.

The container is a plain `.zip` rather than an extension of our own because
the Android and iOS pickers filter by type, and a custom extension is one more
way for a backup to become unselectable.

The Markdown export stays. It answers "get my notes out in a form other tools
read"; this answers "get my library back". Neither does the other's job.

**2. What is left out: who this device is, and anything that can be rebuilt.**
No `identity` (the signing key), no `device_pairs`, no `device_endpoints`. A
restore that carried the identity would give two devices one node id, which
everything in ADR 0009 assumes cannot happen, and it would put a private key in
a file that is going to sit in someone's cloud storage. A restored device is a
new device, and it pairs again.

The derived tables (links, todos, tags, search, the attachment index) are not
included. The import rebuilds them, the same way a peer's content is indexed on
arrival. Backup history and the schedule (ADR 0026) describe this device, not
the library, and are not included either.

Attachments are the set `list_attachment_manifest` advertises to a peer: held
in full, and embedded by a live document. An image whose bytes have not reached
this device cannot be included, and the count is reported, as the export
reports it.

**3. Rust writes the archive, from a snapshot, without the webview.** Unlike
the export, there is nothing to render, so no content crosses IPC. Documents
are read through a second, read-only connection inside one read transaction.
WAL gives that transaction a consistent snapshot, and the app's own connection
is never held for the length of a large backup, so the editor keeps saving
while it runs.

The archive is built in a staging directory under the app's cache directory,
and only then delivered to its destination, disk or remote (ADR 0025). A failed
write never leaves a partial file where the user will later look for a backup.
A manual backup needs no flush from the editor: it is started from
settings, and leaving the editor to get there has already written its pending
save. A scheduled one takes what is saved (ADR 0026).

**4. Import merges, and it goes through the sync path.** An import is a peer
that happens to be a file. For each document, the decision is the one
`DocSyncProtocol.reconcileEntry` already makes: create a document this device
has never seen, take a newer title, record a tombstone for a document never
held here, merge the content as an update. That decision moves out of the
protocol into a pure `reconcile.ts` that both use, so the rules for a peer and
for a backup cannot drift apart. Content goes through
`DocumentRepository.mergeDelta`, so an open document takes the change live,
derived rows are rebuilt by the headless indexer, and writes are serialised per
document like any other write.

There is one departure from sync: **an import never deletes a document this
device holds live**, even when the backup carries a newer tombstone for it.
Sync applies that tombstone, because it records what the user did on another
device. An import is something the user does to get data back, and it should be
safe to run without thinking about what it might remove. If a paired device
holds the same tombstone, sync applies it later, on its own terms.

There is no "replace everything" restore. On an empty device a merge is a
restore, and on a device with paired peers a replacement would be merged away
by the next sync anyway.

Import is idempotent. Merging a state a document already contains changes
nothing, so importing the same backup twice is harmless.

Preferences follow the same rule of filling in and never overriding: the
backup's theme is taken only on a device where nobody has chosen one, which is
the device being set up from nothing that it exists for.

**5. The archive is validated before anything is imported, and entry names are
never paths.** Rust stages the file, then checks that:

- the manifest names this format;
- `formatVersion` is one this build understands (a newer one is refused with
  "update the app");
- `encryption` is null (see decision 6);
- the entry count, each entry's uncompressed size and the total are under fixed
  caps, which is the zip-bomb defence;
- every entry's SHA-256 matches the manifest;
- every document id is a plausible id.

Entries are read into memory by name and never extracted, so a name like
`../../x` is only a string that fails to match. Attachments are written by Rust
through `store_attachment`, which verifies the hash and sniffs the type from the
bytes, so the archive's own names decide nothing. A document state that does
not parse costs that one document, and it is named in the summary.

Before anything is written, the user sees a preview: which device the backup
came from, when it was made, and how many documents and images are new,
already here, or different in the backup.

**6. Encryption has a place in the format, and is not in v1.** `encryption` is
written as null, and a reader that finds anything else refuses the file rather
than misreading it. An encrypted backup later keeps the manifest readable, for
the preview, and puts everything else in one encrypted payload inside the same
zip, so listing, preview and version checks do not change.

**7. No path crosses IPC, in either direction.** Dialogs open in Rust, as they
do for `pick_and_import_image` and `export_notes`. On Android and iOS a picked
file is a content URI rather than a path, and `into_path()` fails on it. Backup
reads and writes those through `tauri-plugin-fs` called from Rust. The dialog
plugin already depends on it, and registering it grants the webview nothing:
neither capability file lists a filesystem permission, so its commands stay
unreachable from the webview.

## Alternatives considered

**Copy the SQLite file (`VACUUM INTO`).** One statement, and lossless.
Restoring it means swapping the database under a running app, it carries the
identity and the pairings with it, and paired devices would sync their own
state over the restored one regardless. The merge reaches the same result
without any of that.

**A replace-everything restore mode.** Rejected for the reasons in decision 4,
and because it is the only way an import could destroy data.

**Apply the backup's tombstones to live documents, exactly as sync does.** More
consistent with sync, which is the reason the import reuses sync's rules at
all. Rejected for the one case where the two disagree: an import should never
be the thing that removes a note.

**Re-import the Markdown export.** One format for both jobs. It needs a
Markdown to ProseMirror parser kept in step with the schema, it loses what
Markdown cannot hold, and a note re-created from text shares no history with
its surviving copy, so merging the two duplicates content instead of
converging.

**Write the archive from the webview.** The export needs the webview because it
renders. This does not, and passing every document's state through IPC as
base64 only for Rust to write it out again is pure cost.

## Consequences

- **A note deleted after a backup stays deleted when that backup is
  imported.** The tombstone is newer than anything the backup holds, and the
  delete dropped the content (ADR 0008). A backup protects against losing data,
  not against changing your mind; point-in-time restore would be a different
  feature.
- **A restored device is a new device.** It gets a new identity and pairs
  again.
- **Images that had not reached the backing-up device are not in the backup.**
  Reported when the backup is made, as the export reports them.
- **A backup is readable by anyone who holds the file** until encryption lands.
  That matters most for remote copies (ADR 0025).
- **Importing a large backup is visible work.** Every document goes through the
  merge and the headless indexer. Documents are imported one at a time rather
  than held in memory together, and progress is reported per document.
