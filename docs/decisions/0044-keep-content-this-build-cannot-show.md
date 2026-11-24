# 0044: Keep content this build cannot show

- **Status:** Proposed
- **Date:** 2026-11-24
- **Extends:** [0010](0010-apply-remote-updates-into-the-open-document.md), [0037](0037-let-mcp-clients-read-and-edit-notes-through-the-running-app.md)

## Context

Devices run different builds, and a paired device can store anything in a note.
y-tiptap answers whatever it cannot make into a node by deleting it from the
Y.Doc while reading it: a block from a newer build, the words beside formatting
it does not know, a list a merge left empty. Opening a note, reading included,
or indexing it was enough, the index is taken of the open copy too, and the
deletion was saved and synced. Content that is not an element made the note
throw instead. A known node in the wrong place was rewritten.

## Decision

**1. Reading never writes and never throws.** `NoteReader` reads a note for the
editor and for everything without one: index, export and MCP.

**2. What cannot be shown is a placeholder, one to each thing stored.** It is
an atom that says the words in the content, and is never stored itself. The
content stays in the Y.Doc, named by its Yjs id. A node that only lacks
something it has to have is shown with it. Formatting by an unknown name is
carried as a mark, so its words can be edited.

**3. A note holding any of this has a writer of its own.** `NoteWriter` is
y-tiptap's, which matches placeholders first and leaves them alone, writes
moved content again from a copy, and leaves unknown attributes where they are.
Every other note is still written by y-tiptap's `updateYFragment`.

**4. Such a note is written when it is edited and not before,** so the empty
line the editor adds after a last block is not stored by opening it.

**5. The index looks into it.** Its words, links, tags and attachments are
indexed, or an image only a newer build shows would be collected here. Its
tasks are not, as there is nothing to tick. `INDEX_VERSION` is 4 for this.

**6. Taking it out is asked for.** The first Backspace or Delete beside one
selects it. An assistant's edit that rewrites or removes one is refused unless
it accepts the loss.

## Alternatives considered

**Opening such a note read-only.** One newer block would stop an older phone
writing in the day's journal, and ticking a task while reading writes too.

**Leaving the content out of the editor.** Nothing would say it is there, and
an MCP edit finds blocks by counting them.

**Making `schema.node` return a placeholder.** y-tiptap's writer matches by
node name from both ends of a list, so an edit on both sides replaces it.

## Consequences

- `noteSync.ts` stands in for y-tiptap's sync plugin under its key, and its
  tests compare it with y-tiptap byte for byte on ordinary notes. Run them when
  updating y-tiptap.
- An unknown attribute is lost when its own block is turned into another kind.
- More than 200 elements deep, content is kept and not shown.
- Builds before this one still delete such content from a note they open or index.
