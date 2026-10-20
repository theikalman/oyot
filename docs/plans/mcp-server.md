# Plan: let MCP clients read and edit notes

Claude Desktop (or any MCP client, such as Claude Code) can search, read, create
and edit notes and journals in a running Oyot desktop app. An edit lands the way
any local edit does: in the open editor, in the index, and on every paired
device.

Desktop only (macOS, Windows, Linux). Phones are out of scope.

## Architecture

```
Claude Desktop
   |  stdio (JSON-RPC, MCP)
   v
oyot --mcp            bridge: same binary, no Tauri, only copies bytes
   |  Unix socket / named pipe, this user only
   v
Oyot app (Rust)       MCP server: handshake, tools/list, tools/call
   |-- SQL tools ------------> SQLite (search, todos, tags, backlinks, list)
   |-- "mcp-request" event --> page (webview)
                                 DocumentRepository write queue
                                 Markdown <-> ProseMirror <-> Yjs
                                 save() -> save_yjs_update -> SQLite + LiveUpdate
```

### Decisions and why

1. **The MCP server runs inside the app, never as a second writer.** The app
   already serialises writes per document, applies them to the open editor,
   re-indexes, and tells peers. ADR 0031 decision 8 holds that the database is
   never opened twice. A separate process writing SQLite would bypass all of
   that.
2. **The bridge is the same binary, started with `--mcp`.** It is handled in
   `main.rs` before `oyot_lib::run()`. Otherwise
   `tauri_plugin_single_instance` (ADR 0030 decision 6) would swallow the
   launch and just focus the window. The bridge only pipes bytes, so all MCP
   logic lives in one place and the bridge never needs updating on its own.
3. **App to bridge goes over a local socket, not HTTP.** On macOS and Linux
   it's a Unix socket at `<app data dir>/mcp.sock` with mode `0600`. On Windows
   it's a named pipe with a per-user name and `reject_remote_clients`. No
   port, no token, and the operating system decides who can connect.
4. **Markdown conversion stays in TypeScript, in the page.** The exporter and
   importer already exist, have about 1,300 lines of tests, and use the
   editor's schema. Porting them to Rust would mean two implementations to
   keep in step. Tools that need no Markdown (search, todos, tags, backlinks,
   list) are answered from SQL in Rust and work even if the page is busy.
5. **An edit is a whole-note rewrite, applied as a block diff.** Claude sends
   the full new Markdown. Unchanged blocks keep their original nodes and Yjs
   items, and only changed blocks are replaced. Concurrent edits elsewhere in
   the note survive, and the editor barely moves.
6. **Optimistic concurrency uses a `revision` token.** A read returns
   `revision = sha256(markdown it produced)`. An edit must send it back. The
   page re-renders the current document in the same write step and refuses
   the edit if the revision differs. Hashing the Markdown rather than reading
   `content_hash` also covers unsaved typing in an open editor.
7. **Off by default.** A setting has three modes: Off, Read only, and Read and
   write. Read only hides the write tools from `tools/list`.
8. **No delete tool in v1.** Deletion propagates to every device (ADR 0008,
   0012). A mistaken delete is too costly for what it saves.
9. **Ticking a todo is its own tool, and its own minimal edit.** `toggle_todo`
   sets the `checked` attribute on one task item's Yjs element and touches
   nothing else. This is the same reasoning as the tag rename
   ([renameInDoc.ts](../../src/lib/tags/renameInDoc.ts)): it's the smallest
   edit that says what happened, two devices ticking the same item resolve as
   last-writer-wins, and there's no Markdown round trip that could lose
   anything. A todo is addressed by `(note_id, ordinal)` from the todo index,
   guarded by its expected text, because ordinals are renumbered on every
   index pass.
10. **Attachments can be read as MCP image content.** Notes refer to images as
    `oyot-attachment://<hash>`. `read_attachment(hash)` returns the image so
    Claude can see it, and `read_note` can include a note's images inline. Only
    attachments that a live note still embeds are served, matching what sync
    and export expose (`referenced_attachments` in
    [attachments.rs](../../src-tauri/src/commands/attachments.rs)). Large
    images are downscaled in the page, not with a new Rust image crate.
11. **Claude's edits aren't recorded as Claude's.** An MCP edit is stored like
    any local edit, with no attribution or marker.

## Phase 0: ADR and spikes

- **0.1 Write ADR 0037**, "Let MCP clients read and edit notes through the
  running app", as Proposed. It records decisions 1 to 11 above, as its
  decisions 1 to 12 (the setting gets a decision of its own). Alternatives
  considered:
  - a separate process with its own DB connection
  - HTTP on localhost with a token
  - porting the converters to Rust with `yrs`
  - a separate `oyot-mcp` sidecar binary
  - y-tiptap's `updateYFragment` as the diff (see 2.3)

  Add it to the index in `docs/decisions/README.md`.

- **0.2 Spike: stdio from a Windows GUI binary.** `main.rs` sets
  `windows_subsystem = "windows"` in release builds. Check that Claude Desktop
  can talk to `oyot.exe --mcp` over inherited pipes. Fallback: a console
  `[[bin]] oyot-mcp` in the same crate, shipped as a Tauri `externalBin`
  sidecar.
- **0.3 Spike: a hidden page answers events.** ADR 0030 notes throttled timers
  on macOS and Linux when the window is hidden. Measure the round trip of a
  Tauri event to the page and back with the window hidden, and after an hour
  hidden. If it's unreliable, page-backed tools return a clear error ("Open
  the Oyot window") and SQL tools keep working.
- **0.4 Check image limits.** Find the current limits for image content in
  MCP tool results, both in Claude Desktop and in the API behind it: bytes per
  image, images per result, and the recommended maximum dimension (1568 px on
  the long edge at the time of writing). These set the constants in 2.6 and 4.
- **0.5 Pick the MCP library.** Prefer `rmcp`, the official Rust SDK, if it
  can be served over any `AsyncRead + AsyncWrite`. The socket needs that.
  Otherwise hand-roll the small surface: `initialize`,
  `notifications/initialized`, `ping`, `tools/list`, `tools/call`. Pin the
  version.

### Phase 0 results (2026-10-20)

| Item              | Status                           | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 ADR           | Done                             | [ADR 0037](../decisions/0037-let-mcp-clients-read-and-edit-notes-through-the-running-app.md), Proposed, added to the index                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 0.2 Windows stdio | Pending: needs a Windows machine | Rust's docs say a GUI-subsystem process gets null standard handles when it inherits a detached console, and std's `Read`/`Write` then silently do nothing. Claude Desktop spawns servers with explicit pipes, which should be unaffected, but nothing confirms it. Test `oyot.exe --mcp` under Claude Desktop before PR 4                                                                                                                                                                                                                                                         |
| 0.3 Hidden page   | Linux done, macOS pending        | Linux (Wayland, WebKitGTK 2.52.6, debug build, isolated `identifier`): a Rust-to-page event answered by an `invoke`, with a `setTimeout(0)` hop in between, every 5 s. Visible: median 4.9 ms (one 797 ms outlier while the page was still loading). Hidden for 15 minutes: 183 of 183 answered, median 4.3 ms, p95 5.3 ms, max 10.3 ms, and the timer hop never above 1 ms, so no throttling showed up. A 10 s relay timeout leaves plenty of margin. Still to do: macOS, which ADR 0030 says may throttle timers to about 2 s, and a hidden period of hours rather than minutes |
| 0.4 Image limits  | Done                             | JPEG, PNG, GIF, WebP only, first frame of an animation. 8000 x 8000 px and 10 MB (base64) per image on the API. Long edge 1568 px (2576 px on Claude 4.7 and later). Over 20 images in a request, keep both sides at 2000 px or less. Claude Desktop is reported by several MCP servers, not by Anthropic, to cap a tool result at 1 MB. **Constants:** `maxEdge = 1568`, a raw-byte budget of 700 KB per result shared by all its images, and at most 5 images per `read_note`                                                                                                   |
| 0.5 MCP library   | Done, pending a dependency check | `rmcp` serves any tokio `AsyncRead + AsyncWrite` through its `transport-async-rw` feature, which covers a Unix socket and a named pipe. Latest is 3.6.0, released 2026-10-20; pin 3.5.1 or whatever is two weeks old when PR 4 starts. Check `cargo tree` for what its features pull in before committing to it                                                                                                                                                                                                                                                                   |

Also found: issue reports that Claude Desktop sometimes drops large `tools/call`
requests (one around 1 KB of arguments) and, on Windows, `tools/list` responses
over about 2.5 KB. Most were closed with no fix named. Keep tool descriptions
short, and test the full `edit_note` of a long note in Claude Desktop early, in
PR 6, with Claude Code as a second client.

## Phase 1: Converter fixes (TypeScript, standalone PR)

These are the gaps the round-trip probe found. Each one improves export and
import on its own.

| Gap                                                         | Change                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Underline dropped                                           | Export writes `<u>text</u>`. Import maps `html_inline` `<u>` / `</u>` to the underline mark, which today is kept as literal text                                              |
| Cell alignment dropped                                      | Export writes `:---`, `:---:`, `---:` from each column's first-row cell `align`                                                                                               |
| Link title dropped                                          | Export writes `[text](url "title")`                                                                                                                                           |
| Bold or italic on a note link dropped                       | Export wraps the link in the marks. Import already applies active marks to the chip                                                                                           |
| Note link with a stale title becomes plain text plus a chip | New read option, `noteLinkLabelIsTitle`. When set, the link's words become the chip's stored title instead of text in front of it. The archive import keeps today's behaviour |
| Image with no description gets alt "missing attachment"     | New export option to leave the alt empty, for the MCP case where the bytes are not in an archive                                                                              |

Files: [src/lib/export/markdown.ts](../../src/lib/export/markdown.ts),
[src/lib/import/markdown.ts](../../src/lib/import/markdown.ts) and their
tests.

Add `src/lib/import/roundTrip.test.ts` with the 24 probe cases. Cases that
Markdown can't carry are asserted as known losses, so any change in either
direction shows up:

- hard break in a heading
- table without a header row
- multi-paragraph cell
- empty spacer paragraphs
- image size
- column widths

Amend ADR 0021 and 0029 where they list what's lost.

## Phase 2: Note Markdown for MCP (TypeScript)

New module `src/lib/mcp/`, pure and tested without Tauri, like the converters.

### 2.1 `noteMarkdown.ts`: render

`renderNote(root, ctx) -> { markdown, revision, blocks }`

- `ctx.notePath(id)` gives `oyot://note/<id>`. `ctx.attachmentPath()` gives
  null, so images come out as `oyot-attachment://<hash>`.
- `blocks` is each top-level block serialised on its own, needed by 2.2.
  Export a `serializeBlock` from the exporter rather than re-implementing it.
- `revision` is the hex SHA-256 of `markdown`.
- Notes written before attachments were content-addressed can still hold an
  image as an inline `data:` URI (see `image()` in the exporter). Writing it
  out would fill Claude's context with base64. Instead it is rendered as
  `![alt](oyot-inline-image://<sha256 of the URI>)`, and `renderNote` also
  returns `inlineImages: Map<id, dataUri>`. `parseNote` maps those ids back
  to the original URI, so an edit near the image keeps it, and
  `read_attachment` can serve it (2.6).
- `attachments` lists every image in the note: `{ ref, alt }`, where `ref`
  is an attachment hash or an inline-image id, in document order.

`parseNote(markdown, ctx) -> ProseMirrorNode`

- Takes `knownTags` (every name in `document_tags`) and a `noteLink` that
  resolves `oyot://note/<id>` against the document list. It sets
  `noteLinkLabelIsTitle`.
- An unknown note id or attachment hash stays as a plain link, the
  importer's existing behaviour.

### 2.2 `planEdit.ts`: block alignment

`planEdit(current, newMarkdown, ctx) -> { root, hunks, lossy }`

1. Canonicalise both sides. Parse the new Markdown, then re-serialise each new
   block, so `*a*` vs `_a_` or spacing differences don't count as changes.
2. Run a Myers / LCS diff over the two lists of canonical block strings.
3. Equal blocks keep the original `ProseMirrorNode`. That preserves image
   sizes, column widths and anything else Markdown can't carry.
4. Mark an original block fragile when `parse(serialize(block))` is not
   `.eq(block)`. If a hunk changes, rather than just deletes, a fragile block,
   report it in `lossy` with what would be lost.
5. Return the hunks as `{ from, to, insert: ProseMirrorNode[] }` against the
   original top-level indices.

### 2.3 `applyEdit.ts`: Yjs operations

Don't use y-tiptap's `updateYFragment` for the whole note. It only keeps the
matching prefix and suffix, so with two separate edits it can delete and
re-insert every block between them, which loses concurrent edits there.

Instead, inside one `ydoc.transact(..., MCP_ORIGIN)`, for each hunk from last
to first:

- `fragment.delete(from, to - from)`
- build the inserted nodes in a scratch `Y.Doc` with
  `prosemirrorJSONToYXmlFragment`, then `fragment.insert(from, scratch.toArray().map((n) => n.clone()))`

Stretch goal: when a hunk is one paragraph replaced by one paragraph, diff
the text and edit the `Y.XmlText` in place, so a typo fix doesn't replace the
paragraph.

### 2.4 Tests

- Render and parse are stable on every round-trip case.
- `planEdit`: no-op edit, insert at the start, middle and end, two separate
  edits, deleting a block, editing a fragile block (reported as lossy),
  rewording only (no hunks).
- `applyEdit` gives exactly `planEdit(...).root` when rendered back
  (`yXmlFragmentToProseMirrorRootNode`).
- Unchanged blocks keep their Yjs item ids.
- Concurrency: fork a `Y.Doc`. On copy A, type into block 5. On copy B, run
  an MCP edit of block 1 and another of block 9. Merge both ways: all three
  edits survive and both copies converge.
- Inline images: a note with a `data:` image renders without base64, an edit
  of the paragraph after it keeps the image byte for byte, and an unknown
  `oyot-inline-image://` id stays a plain link.

### 2.5 `todos.ts`: ticking one task

`toggleTodoInFragment(fragment, ordinal, expectedText, checked) -> result`

- Walks the Yjs tree depth-first, counting `taskItem` elements exactly as
  `extractDocumentIndex` and `locateTaskItem`
  ([taskItems.ts](../../src/lib/editor/taskItems.ts)) count them. Nested
  items are numbered where they're read.
- Before writing, it checks the item's text against `expectedText`, using
  `taskItemText` on the item rendered to ProseMirror, the same function that
  wrote the index row. If the ordinal doesn't exist or the text doesn't
  match, the result is `moved`, and nothing is written.
- Writes only `element.setAttribute('checked', checked)`, as the tag rename
  writes only `name`. `checked` is the value to set, not a flip, so a retried
  call doesn't undo itself.
- Results: `changed`, `unchanged` (already in that state), `moved`.

Tests, sharing the nested fixtures from `taskItems.test.ts` so the two walks
are proven identical:

- for every fixture and every ordinal, the Yjs walk finds the item that
  `locateTaskItem` finds
- tick, untick, and ticking an item that's already ticked
- a text mismatch and an out-of-range ordinal both leave the document
  untouched
- concurrency: device A ticks an item while device B edits its text; both
  survive

### 2.6 `images.ts`: images for Claude

`prepareImage(bytes, mime, maxEdge, maxBytes) -> { bytes, mime, scaled }`

- Within limits and a type Claude reads (PNG, JPEG, GIF, WebP): returned as
  it is.
- Otherwise: `createImageBitmap`, draw to an `OffscreenCanvas` scaled so the
  long edge is at most `maxEdge`, then `convertToBlob`. The output is PNG when
  the source has transparency, JPEG at 0.85 otherwise. Quality steps down
  until the result is under `maxBytes`.
- Animated GIFs come back as their first frame when scaled, and the result
  says so.
- `maxEdge` and `maxBytes` come from spike 0.4.

Tests use small generated images: one that passes through as it is, one
that's too large in pixels, one that's too large in bytes, a transparent PNG,
and an unsupported type, which is refused.

## Phase 3: The page's side (TypeScript)

### 3.1 `DocumentRepository` methods

Follow `renameTagIn` ([DocumentRepository.ts:298](../../src/lib/sync/DocumentRepository.ts:298)):
run inside `this.write(docId, ...)`, with no `await` between looking up the
open doc and encoding.

- `mcpRead(docId)`: render from `getOpenDoc(docId)` if open, else `loadDoc`.
  Returns markdown, revision, title, type, dates, and the `attachments` list.
- `mcpToggleTodo(docId, ordinal, expectedText, checked)`: the `renameTagIn`
  pattern exactly. If the note is open, `toggleTodoInFragment` runs on the
  live doc and the editor saves it. If it's closed: load, edit, encode the
  delta, `readIndex`, `save()`, `bumpIndexRevision()`. A `moved` result
  returns the note's current todos, so Claude can retry with the right
  ordinal.
- `mcpInlineImage(docId, id)`: finds the inline image by its id in the
  rendered note and returns the decoded bytes and type.
- `mcpPrepareImage(bytes, mime)`: runs `prepareImage` (2.6) for Rust when an
  attachment needs scaling.
- `mcpEdit(docId, markdown, revision, { acceptFormattingLoss })`:
  - re-render; if the revision differs, return `conflict` with the current
    markdown and revision, so Claude can retry without another call
  - run `planEdit`; if anything is lossy and `acceptFormattingLoss` isn't
    set, return `lossy` with the details
  - if the note is open, apply to the live doc; the editor's save path does
    the rest, as with a tag rename
  - if it's closed, `loadDoc`, take the state vector, `applyEdit`, encode the
    delta, `readIndex`, `save()`, `bumpIndexRevision()`
- `mcpAppend(docId, markdown)`: insert at the end, sharing the hunk path.
  Needs no revision.
- `mcpCreate(title, markdown, type)`: the existing `create_document` command,
  then `importContent` with the built update, mirroring the Markdown import
  ([importNotes.ts](../../src/lib/import/importNotes.ts)).
- Journals: resolve a date to its journal through `get_or_create_today_journal`
  / `upsert_today_journal` ([documents.rs](../../src-tauri/src/commands/documents.rs)),
  then use the methods above.

### 3.2 `src/lib/mcp/bridge.ts`: the relay

- `listen('mcp-request', { id, method, params })` dispatches to the methods
  above, then calls `invoke('mcp_respond', { id, ok, result | error })`.
- Mounted once from `+layout.svelte`, which lives as long as the app, like
  the close listener (ADR 0030 decision 5).
- Errors use typed codes: `not_found`, `conflict`, `lossy`, `invalid_markdown`,
  `read_only`.

## Phase 4: The MCP server (Rust)

New module `src-tauri/src/mcp/`, `#[cfg(desktop)]`.

| File          | Job                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mod.rs`      | Start and stop by setting; called from `setup()` once state is managed                                                                                                                                                              |
| `listener.rs` | Unix socket or named pipe accept loop, one session per connection. On start: remove a stale socket (connect fails), create it with `0600`. Windows pipe name `\\.\pipe\com.ajiyakin.oyot.mcp.<user>`, `reject_remote_clients(true)` |
| `server.rs`   | MCP handshake and protocol-version negotiation, `tools/list` filtered by mode, `tools/call` dispatch, `ping`                                                                                                                        |
| `tools.rs`    | Tool schemas and handlers                                                                                                                                                                                                           |
| `page.rs`     | Relay: pending map `id -> oneshot`, emit `mcp-request` to the main window, `#[tauri::command] mcp_respond`, a 10 s timeout, and an error when no page is loaded                                                                     |

### Tools

Read (available in Read only and Read and write):

| Tool                                        | Backed by                                | Notes                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_notes(query, limit=20)`             | `run_search`                             | Returns id, title, type, snippet, updated_at                                                                                                                                                                                                                                                             |
| `list_notes(type?, pinned?, limit, cursor)` | `get_all_documents` query                | Paginated                                                                                                                                                                                                                                                                                                |
| `read_note(id, include_images=false)`       | page `mcpRead`                           | Markdown, revision, metadata, and attachments (ref, alt, type, size, whether this device has it). Truncated past ~200 KB, with a notice. With `include_images`, the note's images follow the text as image content, up to the per-result limit from spike 0.4, with a note saying how many were left out |
| `get_journal(date, include_images=false)`   | journal lookup + `mcpRead`               | `YYYY-MM-DD`                                                                                                                                                                                                                                                                                             |
| `read_attachment(ref, note_id?)`            | see "Attachments" below                  | One image as image content. `ref` is a hash from `oyot-attachment://`, or an inline-image id, which needs `note_id`                                                                                                                                                                                      |
| `list_todos(checked?, note_id?)`            | `query_all_todos`                        | Each row carries `note_id`, `ordinal` and `text`, which is everything `toggle_todo` needs                                                                                                                                                                                                                |
| `list_tags()`, `notes_with_tag(name)`       | `query_all_tags`, `get_documents_by_tag` |                                                                                                                                                                                                                                                                                                          |
| `get_backlinks(id)`                         | `get_backlinks`                          |                                                                                                                                                                                                                                                                                                          |

Write (Read and write only):

| Tool                                                              | Backed by                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `create_note(title, markdown)`                                    | page `mcpCreate`                                                       |
| `edit_note(id, markdown, revision, accept_formatting_loss=false)` | page `mcpEdit`                                                         |
| `append_to_note(id, markdown)`                                    | page `mcpAppend`                                                       |
| `append_to_journal(date?, markdown)`                              | journal lookup + `mcpAppend`                                           |
| `rename_note(id, title)`                                          | existing rename command (`update_document`), which already tells peers |
| `toggle_todo(note_id, ordinal, text, checked)`                    | page `mcpToggleTodo`                                                   |

Every tool returns text content (Markdown or a short summary) plus
`structuredContent` JSON, except the image tools, which return `image`
content blocks alongside a text block naming the image. Tool descriptions:

- explain the `oyot://note/<id>`, `oyot-attachment://<hash>` and
  `oyot-inline-image://<id>` conventions, `#tag` syntax, and task syntax
- tell Claude to keep untouched blocks byte for byte
- tell Claude to use `toggle_todo` rather than `edit_note` to tick a task

### Attachments

`read_attachment` is answered in Rust where it can be:

1. **Inline image** (`oyot-inline-image://`): goes to the page,
   `mcpInlineImage`, then `prepareImage`.
2. **Not referenced** by any live note (checked against `document_attachments`
   joined to live `documents`): `not_found`. Orphans waiting to be collected,
   and images in deleted notes, are not served.
3. **Referenced but not on this device** (`has_attachment` is false): call
   `SyncManager::request_attachment(hash)` so a connected peer sends it. Return
   `not_on_device_yet`, telling Claude it was requested and to try again
   shortly. `read_note` reports the same as `available: false`.
4. **On this device**: `read_attachment_bytes`
   ([attachments.rs](../../src-tauri/src/commands/attachments.rs)). If the type
   is one Claude reads and the size and pixel dimensions are within limits,
   it's returned straight from Rust and the page isn't involved. Dimensions
   come from the image header, read with a few lines per format rather than a
   new crate. Otherwise the bytes go to the page's `mcpPrepareImage`.
5. **A type Claude can't read** (anything other than PNG, JPEG, GIF, WebP,
   after scaling): `unsupported_type`, with the type. Only images can be
   saved today (`save_image`), so this is a guard rather than a common case.

Writing images (Claude adding an attachment to a note) is out of scope.

### Wiring

- `lib.rs`: start the server in `setup()`, and add `mcp_respond` plus the
  settings commands to `invoke_handler`.
- The setting lives in `Preferences`
  ([config.rs](../../src-tauri/src/commands/config.rs)). Changing it
  restarts the listener and drops open sessions.
- Logging goes through `logging.rs`: tool name, note id, duration. Never note
  content.

## Phase 5: The bridge (`oyot --mcp`)

In `main.rs`:

```rust
fn main() {
    if std::env::args().any(|a| a == "--mcp") {
        std::process::exit(oyot_lib::mcp::bridge::run());
    }
    oyot_lib::run()
}
```

`bridge::run()` uses a small tokio runtime and no Tauri:

1. **Find the socket.** Work out the data dir the way Tauri does
   (`dirs::data_dir()/com.ajiyakin.oyot`). Add a test asserting it equals
   `app_data_dir()`.
2. **Connect.** If nothing is listening, launch the app with `--hidden` (the
   existing autostart flag, `desktop::HIDDEN_FLAG`) and retry for up to 15 s.
3. **Handle a disabled setting.** If the app is running but the setting is
   Off, the socket doesn't exist. Answer `initialize` locally, list no tools,
   and log to stderr "Enable AI assistant access in Oyot settings".
4. **Pipe.** Copy stdin to the socket and the socket to stdout until either
   side closes. Write nothing else to stdout.

## Phase 6: Settings, help, docs

- `src/lib/settings/McpCard.svelte`:
  - the mode picker (Off / Read only / Read and write)
  - a count of connected clients
  - a ready-to-paste Claude Desktop snippet, using the real binary path from
    `std::env::current_exe()`, with a copy button

  ```json
  {
    "mcpServers": {
      "oyot": { "command": "/Applications/Oyot.app/Contents/MacOS/oyot", "args": ["--mcp"] }
    }
  }
  ```

  It also shows the Claude Code equivalent: `claude mcp add oyot -- <path> --mcp`.

- Help page section in `src/routes/help`, and a README section.
- `changelog.ts` entry.
- Later: an `.mcpb` Desktop Extension for one-click install in Claude Desktop.

## Phase 7: Testing

Automated:

- TypeScript: the Phase 1 and 2 suites, plus `bridge.ts` dispatch with a
  mocked `invoke`.
- Rust:
  - `server.rs` over `tokio::io::duplex`: handshake, `tools/list` per mode,
    unknown tool, malformed JSON
  - SQL tools against a test DB, using the existing test setup in `lib.rs`
  - relay timeout and a response that never comes
  - socket permissions and stale-socket cleanup
  - data-dir equality
  - `read_attachment`: referenced and held, held but unreferenced
    (`not_found`), referenced but missing (calls `request_attachment`, returns
    `not_on_device_yet`), oversized (goes to the page), unsupported type
  - image header parsing on PNG, JPEG (including EXIF orientation), GIF and
    WebP samples

Manual, on each of macOS, Windows and Linux:

- MCP Inspector (`npx @modelcontextprotocol/inspector <path> --mcp`):
  every tool, both modes
- Claude Desktop end to end: search, read, edit, create, append to today's
  journal
- the note open in the editor while Claude edits it: the change appears, the
  cursor stays, undo still works
- typing in block 5 while Claude edits block 1: both survive
- a paired device receives the edit
- the window hidden for an hour, then an edit
- the app not running: the bridge starts it hidden
- the setting Off, then Read only: the write tools are absent and a write
  call is refused
- `toggle_todo` from Claude while the note is open in read mode and in edit
  mode, and on the todo index page: the box updates, and a paired device
  receives it
- "describe the photo in my note X": a small image, a large phone photo
  (scaled), an old note with an inline image, and an image a paired device
  hasn't sent yet (requested, then readable on retry)

## Phase 8: Release

- No wire change, since edits are ordinary Yjs updates, so ADR 0007's
  all-devices-update rule doesn't apply.
- Off by default. Bump with `scripts/bump-version.sh`.
- macOS: confirm that Claude Desktop launching the ad hoc signed binary
  (`com.ajiyakin.oyot`, PR 67) inside the bundle works, and that the bridge
  needs no Local Network permission.
- Move ADR 0037 to Accepted.

## PR order

1. **ADR 0037 (Proposed) and spike results** (Phase 0).
2. **Converter fixes and round-trip suite** (Phase 1). Useful on its own.
3. **`src/lib/mcp` render, plan, apply, todos and images, with tests**
   (Phase 2). Not wired in yet.
4. **Rust server, socket, bridge, SQL read tools, setting Off / Read only**
   (Phase 4 partly, Phase 5). The first usable release.
5. **Page relay, `read_note`, `get_journal`, `read_attachment`** (Phase 3.2,
   `mcpRead`, `mcpInlineImage`, `mcpPrepareImage`, the "Attachments" part of
   Phase 4).
6. **Write tools, `toggle_todo`, and the Read and write mode** (the rest of
   Phase 3.1 and the write half of Phase 4).
7. **Settings card, help, README, changelog, ADR Accepted** (Phases 6, 8).

## Risks

| Risk                                                      | Mitigation                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hidden page slow or suspended                             | Spike 0.3. SQL tools don't depend on the page. Clear error for page-backed tools                                               |
| A rewrite clobbers formatting                             | Block diff keeps unchanged nodes. Fragile blocks are refused unless accepted                                                   |
| Claude edits a stale copy                                 | Revision check. A conflict returns the fresh copy                                                                              |
| Windows stdio from a GUI binary                           | Spike 0.2, sidecar fallback                                                                                                    |
| Another local process connects                            | Socket `0600` in the user's data dir, per-user pipe with remote clients rejected. Same trust level as the database file itself |
| Large notes overflow the context                          | Truncation with a notice. Later, `read_note(section=heading)`                                                                  |
| Images overflow the context or hit size limits            | Scaling to the limits from spike 0.4, a per-result image cap, and `include_images` off by default                              |
| `toggle_todo` ticks the wrong item after the note changed | Expected-text guard. A mismatch returns `moved` with the current todos                                                         |
| An image a paired device hasn't sent yet                  | `request_attachment`, then `not_on_device_yet`, so a retry succeeds                                                            |

## Settled questions

- **Recording that Claude made an edit:** not for now (decision 11).
- **A `toggle_todo` tool:** yes (decision 9, 2.5).
- **Reading attachments:** in scope, as image content (decision 10, 2.6, and
  "Attachments" in Phase 4). Writing them is not.
