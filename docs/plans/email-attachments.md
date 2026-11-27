# Plan: attach emails (.eml) to a note

Typing `/` offers **Attach Email**. Choosing it opens a file picker for `.eml`
files. The email goes into the note as a chip on the line, the way a linked
note does. Clicking the chip opens the email full screen: its headers, its
body and the files it carries. Closing it, with the close button, Escape or the
back button, returns to the note where the user left it.

Every platform the app runs on: desktop and phones.

## Status (2026-11-27)

Steps 1 and 2 done on `feat/email-store`. Scope agreed 2026-11-27: the preview is a page over the note,
files inside an email are listed with a Save button, the cap is 32 MB, and
body search, drop and paste, MCP reading and the export round trip are all in.

## What already works

- **The slash menu.** A command registers with `commandRegistry`
  ([CommandRegistry.ts](../../src/lib/tiptap/CommandRegistry.ts)) and the editor
  registers them all on creation
  ([EditorInstance.svelte:224](../../src/lib/editor/EditorInstance.svelte)).
  `ImageCommand.ts` is the model: delete the `/` range, call a Rust command that
  opens the dialog, insert a node with what comes back.
- **A chip on the line.** `DocumentLinkNode`
  ([DocumentLinkNode.ts](../../src/lib/tiptap/nodes/DocumentLinkNode.ts)) is an
  inline atom with an icon, a title and a click handler. An email chip is the
  same shape.
- **Content-addressed attachments.** Bytes live in `attachments/<sha256>.<ext>`
  outside the CRDT, the note holds `oyot-attachment://<hash>` (ADR 0005).
  Sync, backup, the Markdown export and orphan collection already move and
  count these by hash.
- **Picking a file on phones.** `commands/picked.rs` reads what a dialog
  returns, a path on desktop and a content URI on Android.
- **Showing hostile HTML.** `htmlPreview/frame.ts` (ADR 0043) shows HTML in a
  frame sandboxed without scripts, with a policy that allows inline styles and
  `data:` images only, links disarmed and relative addresses resolved to
  nothing. An email's HTML body is exactly this kind of content, and blocking
  remote images is what an email client does anyway, as they are how senders
  track opens.
- **Older builds keep what they do not know** (ADR 0044). A build with that
  change shows an unknown node as a placeholder, keeps it in the Y.Doc, and
  counts any `oyot-attachment://<hash>` in its attributes as in use
  ([unknown.ts:10](../../src/lib/editor/noteBinding/unknown.ts)), so it will not
  collect the email's bytes.

## What has to change, and why

The attachment store takes pictures only, on purpose (ADR 0005, and the
alternatives in ADR 0043). These places assume an image and each needs to
learn a second type:

| Where                                                 | Assumes                                 | Change                                                                                  |
| ----------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `attachments.rs` `ext_for_mime`, `mime_for_extension` | four image types                        | add `message/rfc822` -> `eml`                                                           |
| `attachments.rs` `sniff_image_mime`                   | magic numbers                           | a `sniff_mime` that also recognises an email (see decision 3)                           |
| `attachments.rs` `MAX_IMAGE_BYTES`                    | 10 MB for everything                    | a cap by type: images stay 10 MB, emails get their own                                  |
| `sync/session.rs` `on_attach_piece`                   | refuses anything over `MAX_IMAGE_BYTES` | use the cap for the declared type, the store confirms it                                |
| `sync/session.rs` `on_attach_manifest`                | pulls every entry                       | skip types this build does not store, so a future type is not pulled only to be refused |
| `backup` reader, `store_checked_attachment`           | sniffs images                           | goes through `sniff_mime`, so a restore keeps emails                                    |
| `attachments.rs` `get_local_blob_url`                 | any hash                                | images only: the webview never needs an asset URL for an email                          |
| `documentIndex.ts` `extractDocumentIndex`             | only `image` holds a hash               | an `emailAttachment` case, or orphan collection deletes the email                       |
| `export/markdown.ts`, `mcp/noteMarkdown.ts`           | no such node                            | write the chip as a link                                                                |
| `attributeTypes.ts` `ATTRIBUTES`                      | the schema as it is                     | the new node's attributes (a test holds this table to the schema)                       |

## Decisions

**1. Parse in Rust, with `mail-parser`.** The webview is treated as untrusted
because it renders content from peers, and the image picker already keeps file
reading out of it for that reason. Parsing in Rust means the page only ever
gets plain data: header strings, a body, a list of parts. It also lets MCP read
an email later with no second parser, and adds nothing to the JavaScript
bundle.

`mail-parser` is Stalwart's parser: MIT or Apache-2.0, no required
dependencies, handles MIME, encoded-word headers and every common charset. Its
`full_encoding` feature uses `encoding_rs`, which is already a dependency, for
legacy charsets such as ISO-2022-JP and GBK. Pin **1.0.1** (2026-11-02):
1.0.2 is from 2026-11-23, under two weeks old. `cargo add` will resolve to
1.0.2, so follow it with `cargo update -p mail-parser --precise 1.0.1`. Its
minimum Rust is 1.98; CI uses stable and this machine has 1.99.

**2. An `emailAttachment` inline atom node.** Attributes:

- `src`: `oyot-attachment://<hash>`. The hash is the truth, and the scheme is
  what ADR 0044 builds already look for.
- `subject`, `from`, `date`: read from the email when it is attached and kept
  in the node. The chip shows them without parsing anything, search finds
  them, and the export and MCP can name the email.

Rendered as a chip: an envelope icon and the subject (or "(no subject)"), with
the sender and date as its tooltip. Clicking it opens the preview, in reading
and in editing, as a linked note's chip does. While the bytes have not arrived
from another device the chip looks pending, clicking it says so, and it asks
peers for the bytes (`requestAttachment`, `onAttachmentReady`), as an image
does.

**3. An email is recognised by what it is, not what it is called.** There is no
magic number. The store accepts bytes as `message/rfc822` when they begin with
a header line (`Name: value`, not `<`), `mail-parser` reads them, and they have
at least one of From, Date, Subject or Message-ID. This runs on every path in,
the picker, sync and backup restore, since a peer's declared type is not to be
trusted. HTML or SVG declared as an email is refused.

**4. A cap of its own.** Emails with files attached are often well over 10 MB,
and base64 makes a 20 MB file about 27 MB of email. The cap is 32 MB, as
`MAX_EMAIL_BYTES`. The sync session already scales its timeout with size and
holds one transfer in memory at a time per slot, so 32 MB is affordable on a
phone.

**5. Two commands.**

- `pick_and_import_email() -> Option<{ hash, subject, from, date }>`: opens
  the dialog filtered to `.eml` (Android providers often report `.eml` as
  `application/octet-stream`, so allow that there), reads through
  `picked.rs`, checks the size before reading, stores, announces to peers, and
  returns what the node needs. Mirrors `pick_and_import_image`, and for the
  same reason the path never crosses IPC.
- `read_email(hash) -> { subject, from, to, cc, date, html?, text?, parts[] }`:
  parses the stored email. `parts` is each attached file's name, type and size.
  In `html`, every `cid:` reference to an image part is replaced by a `data:`
  URI, so pictures that came with the email show under the frame's policy.
  Remote addresses are left alone, and the policy blocks them.

**6. The preview is a page over the note, with a history entry.** Opening one
uses SvelteKit's shallow routing (`pushState` from `$app/navigation`, with the
email's hash in `page.state`). The note stays mounted under it, so its scroll
position, caret and unsaved edits are untouched, and the back button,
Android's included, closes the preview because it is a step in the history.
The close button and Escape call `history.back()`. A reload shows the note,
since page state does not survive one.

The page, `EmailPreview.svelte`, shows:

- the subject, then From, To, Cc and Date, all set as text, never as HTML;
- the HTML body in `createFrame` from `htmlPreview/frame.ts`, at the page's
  full height and scrolling, on white as ADR 0043 does; or the text body in a
  wrapped, pre-formatted block when there is no HTML;
- the attached files as a list of name, type and size, each with a Save
  button (decision 9). Nothing is opened in another app: that would hand a
  file from a peer to whatever the system opens it with.

Why not the dark lightbox the images and HTML blocks use: an email is a page to
read, with headers and a list under it, not one thing to look at closer, and
the lightbox has no history entry, so Android's back key would leave the note
rather than close it.

**7. Search finds the body too, through a table of its own.** The subject and
sender are in the node, so the note's own index has them. The body is not in
the note, and the note's index is built by the editor from the note alone.
So:

- When an email is stored, by any path (picker, drop, sync, restore), Rust
  extracts its text once: the text body, or the HTML body reduced to its
  words, capped at a size worth searching. It goes into a new FTS5 table,
  `email_search (hash, body)`.
- The search query also matches `email_search`, and reaches notes through
  `document_attachments`, live notes only. A result found this way says it
  matched in the email, with the email's snippet.
- Why not append the body to the note's own row: the editor replaces that row
  on every save, an email arriving by sync after its note would need the note
  indexed again, and FTS5 cannot add a column without rebuilding the table.
  A table keyed by hash needs none of that, and no `INDEX_VERSION` bump.
- The row goes when orphan collection deletes the email.

**8. Export, import and MCP keep the chip.**

- The Markdown export writes the chip as `[Subject](attachments/<hash>.eml)`
  and copies the file into the archive, which `export_filename` gives once
  `eml` is mapped.
- Markdown import turns a link to `attachments/<hash>.eml` or
  `oyot-attachment://<hash>` whose hash is a content hash back into a chip,
  with the link text as its subject, beside `storedImage` in
  `import/markdown.ts`. Sender and date are filled in from `read_email` when
  the bytes are on the device.
- MCP's note Markdown writes it as `[Subject](oyot-attachment://<hash>)`,
  the same link the archive falls back to, and reads that back as the chip.
  This matters beyond reading: an MCP edit rewrites a note from its Markdown,
  so without the way back an assistant's edit would turn every chip into a
  plain link. The sender and date are not in the Markdown; the rendered note
  keeps them by hash and gives them back when an edit is read, as it does an
  inline image's data.
- `read_attachment` on an email returns it as text: headers, the text body
  (or the HTML reduced to words) and the list of files, from the same Rust
  parsing as the preview.

**9. Saving a file an email carries.** `save_email_part(hash, index)`: Rust
parses the email, opens a save dialog with the part's file name, and writes the
part. Neither the path nor the bytes go through the webview. Phones deliver to
the content URI the dialog returns, as `backup.rs` does. The file name is
reduced to a plain name first, so a part called `../../x` names nothing.

**10. Dropping or pasting a `.eml` file attaches it.**

- Pasting, and dropping where the webview receives the file, hand the editor
  a `File`. Recognised by the `.eml` name or a `message/rfc822` type, it goes
  to a `save_email` command as raw bytes over IPC (Tauri 2 takes a binary
  body), not base64 as `save_image` does, since 32 MB as base64 is 43 MB of
  string. Rust checks it exactly as it checks a picked file.
- Desktop Tauri takes file drops for itself while drag and drop is on in the
  window config, which it is by default. Check first whether an image dropped
  into a note works on each desktop platform today. If Tauri takes the drop,
  Rust handles the window's drop event, where the paths come from the system
  and not the page, reads `.eml` files from them and tells the editor where to
  put the chips. A path the page hands to Rust is not accepted, for the
  reason `pick_and_import_image` gives.

## Steps

Each is one pull request.

1. **The store takes emails.** `mail-parser`, `sniff_mime`, the type and cap
   changes in the table, `get_local_blob_url` for images only, the sync
   session's cap by type and skipping of unknown types, backup restore. Rust
   tests only. Nothing in the UI yet.
2. **Attach an email.** `pick_and_import_email`, the `emailAttachment` node and
   its chip, `EmailCommand.ts` registered in the slash menu, the attribute
   table, the index, unknown-content findings, export and MCP Markdown both
   ways.
3. **Read an email.** `read_email` with the `cid:` rewrite, shallow routing,
   `EmailPreview.svelte`, the pending state.
4. **Save a file the email carries.** `save_email_part` and the Save buttons.
5. **Search email bodies.** Text extraction on store, `email_search`, the
   search query and its results, cleanup with orphan collection.
6. **Drop and paste.** `save_email`, the paste and drop handlers, and the
   window drop event if Tauri takes drops.
7. **MCP reading, and details on import.** `read_attachment` for emails, and
   a chip read back from an archive filling in its sender and date from
   `read_email` once the bytes are here. Reading links back as chips is
   already in step 2, since MCP edits need it.
8. **Docs.** ADR 0046, the help page's slash commands, the changelog.

Steps 4 to 7 depend on 1 to 3 and not on each other.

## Tests

- Rust, with hand-written fixtures and no real mail: plain text;
  `multipart/alternative`; HTML with a `cid:` image; a Windows-1252 body and
  an encoded-word subject; a forwarded `message/rfc822` part, listed as a
  file. Refused: HTML, SVG and a PNG declared as `message/rfc822`, an empty
  file, and an email over the cap, on the picker path and the sync path.
- The `cid:` rewrite: a referenced image part becomes `data:`, an `http`
  image is left for the policy to block.
- Search: a word only in an email's body finds the note; not once the chip is
  removed and the email collected, nor in a deleted note; an email that
  arrives after its note is found without the note being saved again.
- Saving a part: a name with `/`, `..` or nothing in it is reduced to a safe
  one; an index past the last part is refused.
- TypeScript: the index collects the hash and the subject; unknown-content
  findings collect the hash; the attribute table matches the schema; export
  writes the link and import reads it back as the chip; MCP Markdown round
  trips the chip through an edit; a pasted `.eml` file goes to `save_email`
  and a pasted image still goes to `save_image`.
- By hand: the preview in a production build on Linux (WebKitGTK) and on
  Android, picking from Files and from a Gmail download; Android back closes
  the preview; an email attached on one device opens on another after sync.
  The app is blank in a plain browser, so the preview component is checked in a
  scratch Vite harness first.

## Risks

- **Builds before ADR 0044 delete the chip.** 0.0.37-alpha deletes any node it
  does not know from a note it opens, and the deletion syncs back. ADR 0044 is
  merged but not released. Release it before this, or ship both together with
  a changelog line to update every device before attaching emails.
- **Builds without step 1 pull and refuse emails** on every connection, up to
  the cap each time, until they update. There is no capability exchange
  (ADR 0007), and the app is one user's devices, so this is transient.
- **Email HTML is the most hostile HTML there is.** The frame's three layers
  (ADR 0043) are what hold it. `allow-scripts` must never be added to that
  sandbox, and the test that says so covers this use too.
- **What WebKitGTK, WebView2 and Android's WebView do with a 32 MB email in
  `srcdoc`.** The HTML part is usually small, but inlined `cid:` images can
  make it large. Cap the total inlined and show the rest as files if it is
  a problem.

- **Search results from emails could crowd out notes.** A long newsletter
  matches many words. Rank a match in an email below one in the note itself.
