# 0021: Export every note as a Markdown archive, rendered in the webview and written in Rust

- **Status:** Accepted
- **Date:** 2026-09-22
- **Extends:** [0005](0005-attachment-sync.md), [0013](0013-derived-rows-are-built-wherever-content-arrives.md), [0014](0014-the-merged-blob-is-the-only-content-store.md)

## Context

A note in Oyot exists as Yjs state in a SQLite blob and its images exist as
content-addressed files beside it. That is a good store and a bad format to be
locked into: there was no way to get a note out of the app except by copying it
out of the editor, one note at a time, and images not at all.

Three constraints shaped the answer.

Content is only readable where the schema is. The CRDT holds a ProseMirror
document, and rendering it needs the editor's extensions, which live on the
frontend (ADR 0013). Rust holds the bytes and cannot read them.

The webview has no filesystem permission, and the security model says it must
not get one: it renders documents and images that arrived from paired devices,
so a script there naming a path is the threat `pick_and_import_image` was
already restructured to remove.

An image's bytes are not necessarily here. Attachments sync separately from
documents and lazily (ADR 0005), so a note can refer to an image whose bytes
are still on another device.

## Decision

**1. The webview renders the Markdown; Rust writes the archive.** One command,
`export_notes`, takes a list of `{ name, markdown }` and a list of attachment
hashes, opens the save dialog, and writes the zip. No path crosses IPC in
either direction, and the only path written to is the one the user picked in a
native dialog. This is the same split as `pick_and_import_image`, in the other
direction.

**2. One Markdown file per note, under `notes/`, with images under
`attachments/`.** The alternative was a single concatenated file. Per-note
files are what every other note app exports and imports, they let a link
between two notes stay a link, and they mean a note the exporter could not read
costs that one file rather than a hole in the middle of a large one.

Attachments keep the filenames they have in the store, `<hash>.<ext>`, so the
name is decided by the same `ext_for_mime` that named the file on disk. The
frontend asks Rust for those names (`list_export_attachments`) before it
renders, so a link in a note and a file in the archive cannot disagree.

**3. An entry name from the webview is validated, not sanitised.** A zip entry
name is a path on the machine that extracts it, and these are chosen by the
untrusted surface, so `../../.ssh/authorized_keys` is a real attack on the
user's own filesystem. `validate_entry_name` refuses anything that is not
recognisably one filename ending in `.md` - no separators, no leading dot, no
control characters, no drive colon - and the export fails loudly rather than
writing a name it had to repair. Hashes are checked as 64 hex characters for
the same reason.

**4. Metadata goes in YAML front matter.** `id`, `title`, `type`, `created`,
`updated` and `tags`. The id is the only thing that could ever match an
exported file back to the note it came from, and the tags would otherwise be
the one piece of a note that Markdown has nowhere to put. The title is
repeated as an `# H1` so a plain viewer still shows what the note is called.

**5. A partial export is reported, not prevented.** An image whose bytes are
not on this device is written as a reference to `oyot-attachment://<hash>` with
the alt text "missing attachment" rather than a link into `attachments/` that
resolves to nothing, and the count is surfaced as a warning. A document this
build cannot render exports as its front matter alone, and is named in a second
warning. Neither fails the export: losing one note out of three hundred is not
a reason to hand the user nothing.

## Alternatives considered

**Render the Markdown in Rust.** It owns the bytes, so this would be one
command and no IPC. Rejected: it would need a Yjs implementation and a
ProseMirror schema in Rust, kept in step by hand with the extension list that
actually defines the documents. The failure mode is silent - a node type Rust
has not been told about exports as nothing - and it is the same failure ADR
0013 was written about.

**Let the frontend write the file through the filesystem plugin.** Rejected
outright: it inverts the security model for a feature that does not need it.

**HTML or a JSON dump instead of Markdown.** HTML is what the editor already
renders and would be lossless, but it is not a format anyone edits notes in.
A JSON dump of the CRDT would be lossless and a perfect backup, and is a
different feature - this one is "get my notes out in a form other tools read".

**Include orphaned attachments.** The export takes the same set
`list_attachment_manifest` advertises to a peer: held in full, and still
embedded by a live document. A blob no note refers to is not part of the notes.

## Consequences

Markdown is lossy and this export is lossy in known ways. An image's display
width and a table's column widths are presentation attributes with no Markdown
spelling, and they are dropped. A document link becomes a relative link to the
other note's file, carrying the title snapshot the chip holds, so an export
made before a rename says the old name while still pointing at the right file.
A table whose first row was not a header row gets one anyway, because GFM has
no table without one.

Rendering happens entirely in memory on the frontend before the dialog opens,
which on a large library is a visible wait. The button says what it is doing;
if that ever becomes too slow, the fix is to stream notes to Rust in batches,
which the command's shape already allows.

Filenames come from titles, so two notes called "Ideas" export as `ideas.md`
and `ideas-2.md`. The suffix falls to whichever was created later, so the names
are stable across exports as long as the titles are.

The archive is written straight to the chosen path, and deleted if the write
fails part way. A half-written zip that opens and is quietly missing notes is
worse than no file at all.
