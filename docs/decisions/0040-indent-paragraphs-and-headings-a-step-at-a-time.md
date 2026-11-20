# 0040: Indent paragraphs and headings a step at a time

- **Status:** Proposed
- **Date:** 2026-11-20
- **Extends:** [0035](0035-keyboard-shortcuts-the-user-can-change.md)

## Context

Text could be moved in only by making it a list item, or with spaces at the
start of a line, which move the first line and nothing else. The request was
for Tab at the start of a paragraph to move all of it in, Shift-Tab to move
it back, and a toolbar button for each, as bold and italic have.

Tab already means something in two places: in a list it nests the item under
the one above, and in a table it goes to the next cell. Anywhere else, it
leaves the note for the next control, as in any text box. So there are four
things to decide: what an indent is in the document, where Tab indents, what
the buttons do in a list, and how the keys are named, since Tab cannot be one
of the shortcuts a user changes (ADR 0035).

## Decision

**1. An indent is an `indent` attribute on paragraphs and headings,** a step
count from 1 to 8, added by a content extension, `Indent`, so it is part of
the schema the sync layer shares. It defaults to null, not 0, and returns to
null when a block is moved back out: the collaboration binding stores every
attribute that is not null, so a note nobody indents is stored exactly as
before. The block draws the count as `data-indent` and `--indent`, and the
stylesheet decides how far a step is: 2rem, about a list's own indent, and
1.5rem on a phone. In rem, so a heading moves as far as the text around it.

**2. Only a paragraph or heading in the note or in a quote is indented.** A
list item's paragraph moves with its item, and a cell's stays in its cell.

**3. Tab indents at the start of the text, or with text selected,** where it
moves every paragraph and heading the selection touches. In the middle of a
sentence it still leaves the note. Shift-Tab moves an indented block back
out wherever the caret is in it, and Backspace at the start of one does too,
before it would join the block to the one above. Lists and tables are asked
nothing new: the extension takes only presses on a block it can indent, and
the rest go on to them.

**4. The toolbar's Increase indent and Decrease indent do what Tab and
Shift-Tab would,** in a list too, where they nest and lift the item. Unlike
Tab, they indent wherever the caret is, since a button means nothing else.

**5. Tab and Shift-Tab are not shortcuts the user can change.** A toolbar
tool can name fixed keys of its own, which its tooltip shows, and the help
page lists them under Indent. The tests hold those keys to the editor's real
bindings, as they do every other key the help page names.

## Alternatives considered

- **A tab character, or spaces, at the start of the line.** Only the first
  line moves, so a paragraph that wraps is not indented, and the characters
  end up in search, export and what an MCP client reads.
- **A wrapper node, like a quote without the line.** Moving a block in and
  out would split and join wrappers, and every reader of the schema, export
  among them, would have another node to know.
- **Tab indenting wherever the caret is,** as some outliners have it. It
  leaves a keyboard user no way out of the note with Tab.

## Consequences

- Markdown has no indent, so export, and what an MCP client reads, leave it
  out. A note imported from Markdown has none.
- A device still on an older version reads an indented block as an ordinary
  one, and an edit there to that block drops its indent, which then syncs.
  Updating every device keeps it.
- Typing `#` and a space to make a heading starts it at no indent. A heading
  made from the toolbar or its shortcut keeps the paragraph's.
