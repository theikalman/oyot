# 0037: Let MCP clients read and edit notes through the running app

- **Status:** Proposed
- **Date:** 2026-10-20
- **Extends:** [0017](0017-a-cross-document-todo-index.md),
  [0020](0020-renaming-a-tag-edits-every-note-that-carries-it.md),
  [0021](0021-export-notes-as-a-markdown-archive.md),
  [0029](0029-import-markdown-files-as-notes.md),
  [0030](0030-keep-running-in-the-tray-when-the-window-closes.md),
  [0031](0031-move-the-sync-engine-into-rust.md)

## Context

The Model Context Protocol (MCP) is how an assistant such as Claude Desktop
or Claude Code reaches outside data. A local MCP server is a command the
client launches. The two then speak JSON-RPC over the command's stdin and
stdout: a handshake, a list of tools, and calls to them. We want an
assistant to be able to search, read and change notes, journals and todos,
and to look at the images in them.

Several things already in place decide most of the shape:

- **The content is a CRDT.** A note's body is the Yjs state in
  `documents.crdt_state` (ADR 0014), holding the editor's ProseMirror tree.
  Only the page can render it against the editor's schema
  (`headlessIndex.ts`). That is why indexing stays in the webview (ADR 0031,
  decision 7).
- **The page already does what an edit needs.** It serialises writes per
  document (`writeQueue.ts`), applies an edit to the open copy if there is
  one, re-indexes, and saves through `save_yjs_update`, which tells
  connected devices. The tag rename (ADR 0020) is an edit that starts
  outside the editor, and it goes exactly that way.
- **One core per process.** The database is never opened twice (ADR 0031,
  decision 8), and `tauri-plugin-single-instance` turns a second launch into
  "focus the running copy" (ADR 0030, decision 6).
- **A desktop's page outlives its window.** Closing the window hides it, and
  the process keeps running in the tray (ADR 0030). Whether a hidden page
  answers promptly depends on the platform's webview.
- **Markdown is lossy, but mostly not.** ADR 0021 lists what the exporter
  can't keep. A round trip of 24 sample documents through the real exporter
  and importer came back exactly the same for 15 of them: headings, marks,
  lists, nested tasks, quotes, code, rules, images, tags including
  multi-word ones, and note links whose title hadn't changed. The other nine
  lost something:
  - underline, link titles, cell alignment, and marks on a note link, which
    are cheap to fix
  - a stale note-link title, which comes back as plain text plus a chip
  - image size and column widths (known, ADR 0021)
  - a table without a header row, or with two paragraphs in one cell
  - a hard break in a heading, and empty spacer paragraphs
- **Todos are addressed by ordinal** (ADR 0017), renumbered on every index
  pass, and `locateTaskItem` turns an ordinal back into an item.
- **Images are content-addressed** (ADR 0005). A note refers to one as
  `oyot-attachment://<hash>`. A note written before that can still hold an
  image as an inline `data:` URI.
- **The host has limits.** Claude's documentation gives these:
  - JPEG, PNG, GIF and WebP only, and an animated image is read as its
    first frame
  - at most 8000 x 8000 px and 10 MB (base64) per image on the API
  - images downscaled past a long edge of 1568 px, or 2576 px on Claude 4.7
    and later models
  - a stricter per-image limit once a request holds more than 20 images,
    avoided by keeping both sides at 2000 px or less

  Several MCP servers report that Claude Desktop caps a tool result at
  1 MB. Anthropic doesn't document this.

## Decision

**1. The MCP server runs inside the app.** A Rust module, desktop only,
holds the protocol and the tools. Nothing outside the app process opens the
database. The server is a client of the same paths the page and the sync
engine already use, so an edit made through it reaches the open editor, the
index and every paired device the way typing does.

**2. The command a client launches is the app's own binary, with `--mcp`.**
`main.rs` checks for the flag before `oyot_lib::run()`, so neither Tauri nor
the single-instance plugin ever starts. In that mode the binary is a bridge:

- it connects to the running app
- if nothing is listening, it starts the app with `--hidden` (ADR 0030,
  decision 7) and retries for a few seconds
- it copies bytes between stdio and the connection until either side closes

The bridge has no MCP logic of its own, so it never needs to change when the
tools do.

**3. App and bridge talk over a local socket, not HTTP.** On macOS and Linux
it's a Unix socket, `mcp.sock`, in the app's data directory, created with
mode `0600`. On Windows it's a named pipe with a per-user name that refuses
remote clients. There's no port to find, and no token to issue or leak. The
operating system decides who may connect, and that is the same user who can
already read the database file.

**4. Off by default, with three modes.** A setting chooses Off, Read only,
or Read and write. When it's Off, the socket isn't there. In Read only,
the write tools aren't listed, and a call to one is refused. Changing the
mode drops connected sessions.

**5. What SQL can answer, Rust answers.** Search, the note list, todos,
tags, notes with a tag, and backlinks are read from the tables the index
already maintains. They don't wait on the page.

**6. Everything that needs the document goes to the page.** Rust relays the
request as an event. The page handles it as one step in that document's
write queue and answers through a command. If the page doesn't answer within
a timeout, the call fails with an error saying so. The page renders with the
existing exporter and parses with the existing importer, with options for
MCP:

- note links as `oyot://note/<id>`, read back with the link's words taken as
  the chip's stored title
- images as `oyot-attachment://<hash>`
- every tag name in `document_tags` passed to the reader, so multi-word tags
  are recognised
- inline `data:` images as `oyot-inline-image://<id>`, mapped back on the
  way in, so base64 never reaches the assistant

**7. An edit is a whole-note rewrite, applied as a block diff.** The
assistant sends the note's full new Markdown. The page:

1. renders each current top-level block to Markdown
2. parses the new text and renders its blocks the same way, so differences
   in spelling (`*a*` and `_a_`) don't count as changes
3. diffs the two lists of blocks
4. keeps the original node of every block that matches, so whatever Markdown
   can't carry survives in the blocks the assistant didn't touch
5. applies each changed stretch as a delete and an insert on the Yjs
   fragment

It does not use y-tiptap's `updateYFragment` over the whole note. That keeps
only the matching start and end, so two separate edits can replace every
block between them, and lose anything typed there at the same time.

A block whose own round trip isn't exact is fragile. An edit that changes,
rather than deletes, a fragile block is refused unless the call accepts the
loss. The refusal says what would be lost.

**8. Edits are checked against what was read.** Reading a note returns a
`revision`, the SHA-256 of the Markdown it produced. An edit must send it
back, and the page compares it against a fresh render taken inside the same
write step. If they differ, the edit is refused and the current text and
revision are returned, so the assistant can redo its change. The revision
hashes the Markdown rather than reusing `content_hash` (ADR 0033), so it
also catches typing in an open editor that hasn't been saved yet.

**9. Ticking a todo is its own tool, and its own smallest edit.**
`toggle_todo(note_id, ordinal, text, checked)`:

- finds the item by walking the Yjs tree in exactly the order that numbers
  the index
- checks the item's text matches what the caller passed, and if it doesn't,
  writes nothing and returns the note's current todos
- sets only the `checked` attribute, the way the tag rename sets only `name`
  (ADR 0020)

`checked` is the value to set rather than a flip, so a retried call can't
undo itself. Two devices ticking the same item resolve as any attribute
does, the later one wins. There's no Markdown round trip, so there's nothing
to lose.

**10. The assistant can see a note's images.** `read_attachment` returns one
image as MCP image content, and `read_note` can include a note's images
after its text. Only an image that a live note embeds is served, the rule
the exporter and attachment sync already follow, so orphans and the images
of deleted notes stay private:

- **Held and within limits:** sent from Rust as it is.
- **Held but too large:** scaled in the page with a canvas to a long edge of
  1568 px and under a byte budget, then sent. 1568 px is the smallest of the
  host's limits, so it suits every model. The budget keeps a whole result
  under the 1 MB that Claude Desktop is reported to enforce.
- **Embedded but not yet on this device:** asked for from connected peers,
  and reported as not here yet, so a retry can succeed.
- **Not one of the four types Claude reads:** refused.

The assistant can't add images.

**11. There's no delete tool.** A deletion reaches every device and wins
over edits made before it (ADR 0008, 0012). That's too much to put behind an
assistant's tool call. The assistant can say what should be deleted, and the
user deletes it.

**12. An assistant's edit is not marked as one.** It's stored, indexed and
synced like any local edit. Nothing records which edits came through MCP.

## Alternatives considered

**A separate MCP process with its own database connection.** It's the
simplest server to write, and it would work with the app closed. Rejected:
it's a second writer to a database that assumes one (ADR 0031, decision 8).
Its edits would miss the open editor, the per-document write queue, the
index and the sync engine. A read-only version still couldn't render a note,
because only the page can.

**HTTP on localhost.** It would let the app be reached by clients that only
speak HTTP. Rejected: a port is visible to every local process and to
browsers, so it needs a token, origin checks and somewhere to show the
token. A socket gets all of that from the file system. Claude Desktop
launches local servers as commands anyway.

**A separate `oyot-mcp` binary, shipped as a sidecar.** It would be a
console program on Windows, where the main binary is built for the GUI
subsystem. Rejected for now: it's a second artifact in every bundle,
renamed per target, and signed on macOS. The bridge is a few lines inside
the binary that's already there. It stays the fallback if a GUI-subsystem
binary can't serve stdio on Windows (open question 1).

**Porting the Markdown conversion to Rust with `yrs`.** It would make every
tool independent of the page. Rejected: it means a second implementation of
1,200 lines of conversion, kept in step with the TypeScript one and with
the editor's schema by hand. The page is already the one place that
understands the schema (ADR 0031, decision 7). The SQL tools cover the
common reads when the page is slow.

**Edits as operations rather than rewrites:** insert after a block, replace
block N, and so on. It's precise and needs no diff. Rejected: assistants are
far better at rewriting text than at addressing positions in a tree they
can't see. Positions also go stale as the note changes. The rewrite reads
naturally to the assistant, and the block diff turns it back into precise
operations.

**`updateYFragment` as the diff.** It's already in y-tiptap and keeps the
editor's mapping. Rejected for the reason in decision 7.

**Ticking todos through `edit_note`.** It works and needs no new tool.
Rejected: it costs a full read and a full rewrite to change one attribute,
and it runs a Markdown round trip over a whole note to do it.

**Scaling images in Rust with an image crate.** It wouldn't depend on the
page. Rejected: it adds a large dependency tree for an occasional job, and
the page can already decode and encode every format the editor shows.

## Consequences

- Assistants can work with notes only on a desktop, and only while Oyot runs
  there. The bridge starts it if it isn't running.
- Reading and changing a note depends on the page answering. On platforms
  where a hidden page is throttled (ADR 0030), those calls may be slower,
  and they fail with a clear error if the page doesn't answer. Search, todos,
  tags and backlinks don't depend on it.
- The exporter and importer now serve three callers: the archive, the import,
  and MCP. Their round-trip suite becomes the contract between them, and a
  change that loses something has to change that suite on purpose.
- An edit to a fragile block is refused by default. An assistant that wants
  to rewrite a table with column widths has to accept losing them, and the
  refusal tells it what that means.
- `toggle_todo` and the todo index must walk task items identically, as
  `locateTaskItem` and `extractDocumentIndex` already must. One shared
  fixture set tests all three.
- Anyone who can run programs as this user can read and change their notes
  while the setting is on. That's the same reach they already have over the
  database file. The setting is off until the user turns it on.
- Claude Desktop is reported to drop very large tool calls and results.
  Rewriting a long note sends all of it. If that proves to be a real limit,
  the remedy is an edit scoped to a section, not a change to this design.

## Open questions

1. **Can a GUI-subsystem Windows binary serve stdio?** Release builds set
   `windows_subsystem = "windows"`. Rust's documentation says a process
   that inherits a detached console gets null standard handles. Claude
   Desktop spawns its servers with explicit pipes, which should work, but
   this has to be tried on Windows. If it fails, the bridge moves to a
   console sidecar.
2. **How promptly does a hidden page answer?** This needs measuring on
   macOS and Linux, with the window hidden for a while. It decides the relay
   timeout and whether the page-backed tools say "open the Oyot window".
3. **Which MCP library?** `rmcp`, the official Rust SDK, can serve any tokio
   `AsyncRead + AsyncWrite` (its `transport-async-rw` feature). Use it,
   pinned to a release that has been out for a couple of weeks, unless it
   pulls in more than its features suggest. Version 3.6.0 came out on the
   day of writing, 3.5.1 before it. The fallback is the five messages a
   server needs, by hand.
