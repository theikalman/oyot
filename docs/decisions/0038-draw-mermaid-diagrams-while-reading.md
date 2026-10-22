# 0038: Draw Mermaid diagrams while reading

- **Status:** Proposed
- **Date:** 2026-10-22
- **Extends:** [0028](0028-open-documents-for-reading.md), [0036](0036-colour-schemes-the-user-can-choose.md)

## Context

A note could hold a Mermaid diagram only as its code: a code block whose
language is `mermaid`, typed with ` ```mermaid ` or imported from Obsidian,
GitHub or an MCP client. Markdown import and export already keep the
language, so the code round-trips. The request was to see the diagram itself
while reading.

Reading is the same editor made read-only (ADR 0028), not a second renderer,
so whatever draws the diagram has to live in the editor. That leaves seven
things to decide: how the diagram replaces the code, which languages count,
when Mermaid is loaded, how far a definition is trusted, what colours it is
drawn in, when it is drawn again, and what a definition Mermaid cannot read
shows.

## Decision

**1. Decorations, not a node view.** A live-editor-only extension,
`MermaidDiagrams`, gives every Mermaid code block two decorations while
reading: a class on its `<pre>` that the stylesheet hides, and a widget just
before it that holds the diagram. Editing, it gives none, so the code is back
and is edited like any other code block. The document does not change.

**2. Only `mermaid` counts,** trimmed and in any case, as other apps write it
on a fence. An empty block draws nothing.

**3. Mermaid is loaded the first time a diagram is drawn,** with a dynamic
import, so it is its own chunk and a note without a diagram never loads it.

**4. A definition is untrusted.** Notes arrive from paired devices and
through MCP, so Mermaid runs at its `strict` security level: no click
handlers, no HTML in labels, and the SVG goes through its sanitiser before it
is put on the page. The app's content security policy is unchanged.

**5. Diagrams are drawn in the scheme's colours,** read from the CSS
variables every scheme defines and handed to Mermaid's `base` theme, so each
scheme gets matching diagrams without a mapping of its own.

**6. A diagram is drawn again only when its definition or the scheme
changes.** The two make the widget's key, so ProseMirror keeps a diagram's
element through every other redraw, and the key also indexes a cache of the
last fifty drawings. A peer typing into a diagram's code while it is being
read is drawn once they stop, after 150 ms.

**7. A definition Mermaid cannot read shows as its code,** under a line
saying why, so a typo never makes a block disappear.

## Alternatives considered

- **A node view on the code block.** It would take over how every code block
  is edited, and the code block is in the schema the sync layer and the
  headless index share, which has to load where there is no DOM.
- **Drawing while editing too, when the caret is outside the block.** Closer
  to some editors, but it makes a click on a diagram ambiguous and puts
  layout changes under the caret. It can come later on top of this.
- **Drawing in Rust, or on a server.** Mermaid needs a browser to lay out
  text, and there is no server.

## Consequences

- Mermaid adds a few megabytes of chunks to the bundle, none of it loaded
  until a diagram is shown.
- Diagrams draw after the page has opened, so the page can move when one
  arrives. The widget starts about the height of the code it stands for, to
  move it less.
- Mermaid's version is pinned exactly, because a new major version can lay
  out a diagram differently or drop syntax.
