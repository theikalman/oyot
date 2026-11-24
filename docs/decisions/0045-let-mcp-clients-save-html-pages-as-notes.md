# 0045: Let MCP clients save HTML pages as notes

- **Status:** Proposed
- **Date:** 2026-11-24
- **Extends:** [0037](0037-let-mcp-clients-read-and-edit-notes-through-the-running-app.md), [0042](0042-import-html-files-as-editable-notes.md), [0043](0043-show-html-code-blocks-as-pages-while-reading.md)

## Context

Assistants make HTML pages: reports, dashboards, artifacts. The request was for
one to put a page straight into Oyot. An assistant could already write an `html`
code block through `create_note`, but nothing told it so, and a page without a
doctype, which is how artifacts are often written, showed as code. The HTML
importer could not be reached at all, since it reads files the user picks.

## Decision

**1. One tool, `create_note_from_html`,** offered with the other tools that
write. It takes a title, the HTML, and a mode. `page`, the default, keeps the
page for the viewer (ADR 0043); `editable` reads it as the importer does (ADR
0042), storing the pictures inside it as attachments.

**2. In `page` mode the HTML is kept as it was sent,** in one `html` code block,
less a byte order mark, carriage returns and space around it. One that does not
begin as a whole page is given a doctype. The viewer does not change, and
neither does how the page is held: scripts still never run.

**3. The content is built before the note is made.** A page with nothing to keep
is an error, with no empty note left behind.

**4. The answer says what will not be seen:** scripts, files outside the page,
what an editable note had to leave out, and a note too long to be read whole and
rewritten. The assistant can then send a better page. It is worked out from the
parsed page and is only a warning.

**5. A page is at most 1,000,000 bytes,** and holds no NUL.

## Alternatives considered

**A path to a file.** It would save the assistant writing the page out. But any
client with access could then copy any file the user can read into a note that
goes to every paired device. No path crosses into the app, as in ADR 0029.

**Only describing the code block in `create_note`.** It leaves the doctype to
the assistant, has no editable form, and cannot say what will not show.

**Running the page's scripts.** Turned down in ADR 0043, for reasons that have
not changed.

## Consequences

- Pages drawn by scripts do not show, and the assistant is told.
- Pictures in a `page` note stay in its text, so they are in its CRDT for good.
- A `page` note past 200,000 bytes can be saved but not rewritten over MCP.
- A saved page is changed with `edit_note`, or in the editor.
- A failure to save after the note is made leaves it empty, as with
  `create_note`.
