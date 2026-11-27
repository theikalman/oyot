# 0046: Attach emails to notes

- **Status:** Proposed
- **Date:** 2026-11-27
- **Extends:** [0005](0005-attachment-sync.md), [0043](0043-show-html-code-blocks-as-pages-while-reading.md), [0044](0044-keep-content-this-build-cannot-show.md)

## Context

The request was to keep an email with the note it belongs to: attach a `.eml`
file from the slash menu, see it on the line as a linked note is seen, and read
it from there, coming back to the note where it was left. The plan is in
[docs/plans/email-attachments.md](../plans/email-attachments.md).

The attachment store took pictures only, on purpose (ADR 0005, and the
alternatives in ADR 0043). An email is a second kind of attachment, and the
most hostile content the app shows: its HTML was written by a stranger, often
to learn when it is opened.

## Decision

**1. An email is an attachment, stored like a picture.** `message/rfc822`,
written as `<hash>.eml`, synced, backed up, exported and collected as pictures
are. It is held to 32 MB, pictures to 10 MB, and the types and caps are in one
pure module, `attachment_types.rs`, that the store and the sync session share.
A type a build does not store is not pulled from a peer.

**2. It is known by its bytes.** An email has no magic number, so it begins
with a header line, `mail-parser` reads it, and it has a From, Date, Subject
or Message-ID. HTML and SVG declared as an email are refused on every way in:
the picker, a paste or drop, sync and a restore.

**3. A note holds an inline `emailAttachment` atom:** its
`oyot-attachment://<hash>` and the subject, sender and date read when it was
attached. A build that does not know it keeps it as unknown content, and
counts the hash as in use (ADR 0044). The chip shows it as pending while the
email is on its way from another device.

**4. Rust reads emails; the page never does.** `read_email` hands the page
plain data: headers, a body and the files it carries. The page sets the
headers as text, and shows the HTML in the sandboxed frame of ADR 0043, sized
to its whole page. Pictures the HTML names by `cid:` become `data:` addresses,
up to 16 MB together; remote ones are left for the frame's policy to refuse,
as a mail client does. SVG is listed as a file rather than shown. The page is
never given an asset address for an email.

**5. The preview is a step in the history over the note.** Shallow routing
keeps the note mounted under it, so the back button, Android's included,
Escape and Close return to it where it was left. A reload shows the note.

**6. A file the email carries is saved, never opened.** Rust opens the save
dialog and writes the part, so neither its path nor its bytes pass through the
page. The name the email gives is only a name: nothing before a slash, nothing
a system refuses, no Windows device name.

**7. Search finds a note by what its emails say,** through a table of its own,
`email_search`, filled when an email is stored and reached through
`document_attachments`. A note found by its own words comes before one found
by an email.

**8. Emails come in by the slash menu, a paste, or a drop.** Files dropped from
the system on a computer go through the one drop path pictures use: Rust holds
the paths behind a one-time token, and the page takes them only when they land
on a note open for writing. A paste goes to Rust as raw bytes.

**9. Markdown keeps the subject.** Export, import and MCP write the chip as
`[Subject](link to the email)` and read it back as the chip. An MCP edit keeps
the sender and date by hash, and a chip read from an archive shows them from
the email without writing them into the note. `read_attachment` gives an
assistant an email as text.

## Alternatives considered

**Parsing in the page,** with a JavaScript parser. The page is where hostile
content is shown, and parsing there would put every byte of the email in it,
for the frame and for MCP alike.

**Emails as a block, or inside the note.** A block reads as a picture does,
where the request was for a chip on the line. The email in the note's text
would be in its CRDT for good, and searched, synced and exported with no way
to keep its files apart.

**The full-size lightbox pictures use.** An email is a page to read, with
headers and files, and the lightbox has no step in the history, so Android's
back key would leave the note.

**Loading remote pictures on request.** It needs the app's content security
policy loosened, and tells the sender the email was read.

**Opening a carried file in another app.** It hands a file from a peer to
whatever the system opens it with.

## Consequences

- Builds before ADR 0044 delete a chip they do not know, and the deletion
  syncs. That build must be released first, and every device updated, before
  emails are attached.
- Builds before this one pull an email from a peer and refuse it on every
  connection, up to 32 MB each time, until they update.
- An email's HTML is shown as it was before any script ran, without its remote
  pictures.
- A file copied in a Linux file manager pastes as a link to it, which the page
  cannot read and may not hand to Rust, so it is not attached.
- What WKWebView, WebView2 and Android's WebView do with a large email page
  was not tried. WebKitGTK 2.52 and Chrome were.
