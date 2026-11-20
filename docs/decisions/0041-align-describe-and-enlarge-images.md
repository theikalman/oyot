# 0041: Align, describe and enlarge images

- **Status:** Proposed
- **Date:** 2026-11-20

## Context

An image in a note always sat on the left of its line, could not be given a
description, and could only be seen at the size it was drawn in the note.
The request was for three things: to put an image on the left, in the centre
or on the right of its line; to give it alt text; and to see it full size,
floating over the note, by clicking or tapping it.

Two things in the way. The `alt` attribute already holds `oyot:<hash>` for
every image the editor inserts, bookkeeping from before the hash moved into
`src` (ADR 0005), and the exporter, the importer and the MCP reader all know
to skip it. And a click on an image while editing already means something:
it selects the image, which is how it gets its resize handles.

## Decision

**1. Where an image sits is an `align` attribute on the image node:** null
for left, `center` or `right`. Null, not `left`, because the collaboration
binding stores every attribute that is not null, so a note nobody aligns is
stored exactly as before, as ADR 0040 does for indents. Anything else, from a
paste or a document edited by hand, reads as left. The node view's container
is already a flex box, so the alignment is where it puts its one child, and
it draws the value as `data-align`.

**2. Alt text goes in `alt`, in place of the bookkeeping.** An image inserted
now names its attachment in `src`, so the hash in `alt` is only a fallback,
and a description replaces it. Cleared, an attachment's `alt` goes back to
`oyot:<hash>`, so a build that still reads the hash from there finds it. The
image shows only a description as its `alt`, not the bookkeeping, which a
screen reader used to read out. The description is written in a dialog, one
line, up to 1000 characters.

**3. A selected image gets its own toolbar,** over its top edge on the side
it is aligned to: Align left, Align centre, Align right, Alt text, and View
full size. It is part of the image's node view rather than a menu floating
over the page, so it scrolls with the image and needs no placing of its own,
and the stylesheet shows it only while the image is selected for editing.
Its presses are its own: the node view stops them reaching ProseMirror, and
a press keeps the editor's focus and the image's selection, so the image
stays selected for the next change. The dialog and the full-size view
belong to the editor around the image, which the toolbar asks with an event
on the editor's DOM.

**4. A click opens an image full size where a click does not already mean
something else.** Reading, any click on an image opens it. Editing, the
first click selects it, as before, and a click on the image already
selected opens it. Whether it was already selected is asked as the press
begins, since ProseMirror has selected it by the time the click arrives. An
image still on its way from another device has nothing to show, and does
not open.

**5. The full-size view** covers the window, shows the image as large as
fits with its description under it, and closes with Escape, the close
button, or a click anywhere but the image. Focus goes in with it and back to
the note after.

## Alternatives considered

- **A separate attribute for the description, leaving `alt` alone.** Every
  reader of the schema, export and import among them, would have a second
  place to look, and Markdown's own place for a description is the alt.
- **Opening full size on any click while editing,** and selecting the image
  some other way. The click is how an image is resized today, and a
  double-click is not something a phone does well.
- **A floating menu over the page,** like a bubble menu. It would need
  placing, and placing again on every scroll and resize, for nothing the
  node view does not already give.

## Consequences

- Markdown has no alignment, so export, and what an MCP client reads, leave
  it out, as they do an image's width (ADR 0021). A description is written
  as the Markdown alt, its brackets and backslashes escaped so it cannot end
  early.
- A device still on an older version shows every image on the left, and
  keeps its description. Resizing an image there drops its alignment, which
  then syncs, as an edit there drops an indent (ADR 0040). Updating every
  device keeps it.
