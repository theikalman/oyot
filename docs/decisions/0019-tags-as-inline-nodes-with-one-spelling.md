# 0019: Tags are inline nodes, and a tag has exactly one spelling

- **Status:** Accepted
- **Date:** 2026-09-21
- **Extends:** [0013](0013-derived-rows-are-built-wherever-content-arrives.md), [0017](0017-a-cross-document-todo-index.md)

## Context

There was no way to say what a note was about other than writing it in the
prose. A title groups a day or a subject, a link joins two notes, and neither
answers "everything about the house move", which is a question that cuts across
both.

Tags answer it, and they bring three decisions with them. What a tag is in the
document. Where the list of existing tags comes from, given that content lives
in the CRDT and nothing in SQL can read it (ADR 0013). And what happens when
two notes spell the same tag differently, which they will, because one was typed
at the start of a sentence.

## Decision

**1. A tag is an inline atom node, not a mark and not a text convention.** A
chip is one thing: backspace takes the whole of it, a click selects the whole of
it, and there is no way to edit the middle of a tag into something the index has
never heard of. A mark over text would allow exactly that, with no moment at
which to renormalise the result. A bare `#word` in the prose would be cheaper
still and was rejected for the same reason: it makes every stray hash a tag and
every tag editable into a non-tag, and it would need a parser in the indexer
rather than a node type.

The name is stored without its hash. The hash is presentation, added by the
renderer, so a tag has one spelling in the CRDT and not two.

**2. A tag has one spelling: normalized, lower case.** `#Work` and `#work` are
the same tag and it is written `work`. `normalizeTagName` is the whole of the
rule (trim, drop a leading hash, collapse whitespace, lower case, cap at 50
characters) and it is applied in three places: when the picker coins a tag, when
the node parses an attribute that came from a peer or a paste, and when the
indexer reads a chip. Nothing downstream has to wonder which case it is holding.

**3. The tags a document carries are derived rows, like its todos.**
`document_tags` is written wherever content arrives, by the same walk and on the
same three paths ADR 0013 established: a local save, a merge from a peer, and
the startup backfill. It is replaced wholesale on every pass, so removing the
last chip spelling a tag is what makes the tag stop existing.

**4. There is no tag registry.** A tag is offered because some live document was
indexed holding it, which means there is no list to curate, nothing to rename
and nothing to go stale. It also means a tag cannot exist before it is used, and
does not survive its last use, both of which are the honest answer.

**5. The picker offers the corpus's tags plus the open document's.** SQL only
learns about a tag when the document holding it is saved, and the save is
debounced, so a tag coined a moment ago in the note being typed in would
otherwise be missing from the picker in that same note. The two lists are merged
and the corpus's ranking (most used first) survives the merge.

**6. `INDEX_VERSION` is not bumped.** Every other addition to the derived rows
bumped it to force a re-render of the corpus. A tag is a node type no earlier
build could write, so there is nothing for a re-render to find, and a bump would
stall attachment collection until one had run for no gain.

**7. A tag name is part of a document's search text**, and part of a task item's
text, for the reason ADR 0017 gives for link titles: an atom contributes nothing
to `textContent`, so "call mum #urgent" would be recorded as "call mum" and the
todo index would show a task that is not the task in the note.

## Alternatives considered

**A `tags` column on `documents`, or a tag registry table the user manages.**
Tags become first-class: renameable, deletable, orderable. Rejected because it
puts a second source of truth next to the document. The chips in the note and
the rows in the table would be free to disagree, and every edit to a note would
have to reconcile them. Deriving the list means they cannot disagree.

**Preserve the case the user typed, and match case-insensitively.** What most
note apps do, and it keeps `#ProjectX` looking like `#ProjectX`. Rejected: it
needs a display form and a match form carried together everywhere, and then a
rule for which of two spellings in the corpus wins. Every answer to that is
arbitrary, and the one thing the user notices about a tag system is when it
quietly holds two tags that look the same. Hyphens are what a name needs for
readability, and they survive normalization.

**Trigger the picker on `#` as it is typed,** rather than only through the slash
menu. It is what people expect from other note apps and it is worth having.
Deferred rather than rejected: it is a second trigger onto the same picker, and
it wants its own answers about what happens to a `#` typed in the middle of a
word or in a code block. The slash menu is where every other insertion in this
editor starts.

**Filter by tag from a tag index page**, in the shape of the todo index.
Deferred: `document_tags` is indexed by name precisely so this is a query away,
but a page that lists tags is only worth writing once there are tags to list.

**Rank the picker by recency rather than usage.** Rejected as guesswork with a
worse failure mode: a list that reshuffles between two reads of it teaches the
user nothing about where a tag will be. Usage is stable, and level tags are
broken by name so even a tie does not move.

## Consequences

- A document holding a tag cannot be read by a build that predates this one:
  the node type is not in its schema. That is the best-effort rule ADR 0013
  already accepts for indexing, but here it reaches the editor, so a device left
  on an older version will fail to open a tagged note rather than showing it
  without its tags.
- Tags are cheap to add and impossible to curate. A typo that is saved becomes a
  tag, and the only way to remove it is to delete the chip; until then the
  picker offers it. The picker offering existing tags before the "add as new"
  row is what keeps a typo from being the common case.
- Renaming a tag means editing every note that carries it. There is nowhere else
  to do it, by decision 4.
- `document_search` now matches on tag names, so a search for "holiday" finds
  notes tagged `#holiday` as well as notes that say the word. That is intended,
  and it means the two cannot be told apart in the results.
- The picker's popup is now shared with the document-link picker
  (`tiptap/pickerPopup.ts`). Both had the same capture-phase key handling,
  click-outside and unmount to get right, and there is now one of each.
