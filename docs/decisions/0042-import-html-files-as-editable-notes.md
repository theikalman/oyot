# 0042: Import HTML files as editable notes

- **Status:** Proposed
- **Date:** 2026-11-24
- **Extends:** [0029](0029-import-markdown-files-as-notes.md)

## Context

Markdown files come in as notes (ADR 0029). The request was for HTML files to
come in too, and to become notes that can be edited like any other, rather than
pages kept as they are. Seeing a page as it looked is a separate feature and is
not decided here.

Most of an import does not care what a file is written in: picking and reading
it, choosing ids, writing notes whole, batching, linking files to each other,
and saying how it went. What differs is the reading, in three ways. HTML is
mostly arrangement, so ADR 0029's rule, that what a note cannot hold stays as
the text it was written as, would fill a note with tags. A single HTML file
often carries its pictures inside it, megabytes of them. And HTML comes in
encodings other than UTF-8, which it names.

It is also hostile. A page off the web carries scripts, trackers and links that
run code.

## Decision

**1. One Import, for both.** `pick_markdown_files` becomes `pick_note_files`
and hands back each file with what it is written in. Rust decides: by the
extension when it says, and otherwise by whether the text opens as an HTML
document, since a file picked on a phone can have no name. One button and one
dialog mean files of both kinds can be imported together, and link to each
other.

**2. HTML is read in the encoding it names.** Text that is UTF-8, or UTF-16
with a byte order mark, is read as before. HTML that is neither is read in the
encoding its XML declaration or `<meta>` names, in its first 4 KB, by
`encoding_rs`, strictly. A file that names none, or is not valid in the one it
names, is still refused rather than guessed at. Markdown does not name one.

**3. The browser's parser reads the file, and nothing it makes is put on a
page.** `DOMParser` gives a document with no window: no script runs, no image
loads, no style applies. A reader walks it and builds nodes against the
editor's schema, as the Markdown reader does, and shares with it the code that
fits content into the schema's shapes.

**4. A page comes in as what it says, not how it looked.** An element that only
arranges others, whatever it is called, gives way to what is inside it.
Headings, paragraphs, quotes, lists, tasks, code, tables, rules, links and
emphasis become their nodes and marks. Emphasis is read from tags and from an
element's own `style`, which is where some tools write it, and not from style
sheets. Scripts, styles, templates, form controls and anything hidden are
not read. This replaces ADR 0029's decision 7 for HTML only.

**5. A title is the page's `<title>`, else its first top-level heading, else
the file's name, else "Untitled".** A top-level heading that opens the content
and only says the title is taken out, as for Markdown.

**6. `#word` stays text.** In a page it is as likely a colour, an issue or a
link to a part of the page as a tag.

**7. A link keeps its address in the schemes a note can follow,** http, https,
ftp, mailto, tel and sms, and in none once control characters are taken out,
which is a relative address. Any other leaves its words. A link within the page
leaves its words too. A relative address is made whole when the page has a
`<base>`.

**8. A picture inside the file becomes an attachment.** Left as a data URI it
would be in the note's CRDT for good. It goes through `save_image`, so Rust
decides its type from its bytes and holds it to 10 MB, before the note is made.
One that cannot be stored gives way to its description. A Markdown file's data
URIs stay as they are, as ADR 0029 decided. Any other image is kept as its
Markdown, as there.

**9. A table is a full grid or it is not a table.** HTML lets rows stop short,
cells reach past the end and cells overlap. The editor mends such a table when
it is opened, which would be a change to the note nobody made, so the reader
mends it first. A table that only arranges a page (it says so, holds another
table, or has one cell), or that would be more than 50,000 cells, gives way to
what is in its cells.

**10. What is content and has no place is counted.** A drawing (`<svg>`,
`<canvas>`) or a picture that cannot be kept is left out and counted in the
summary, in the same warning as the images kept as text, so the warnings still
fit on screen. An icon is not counted. A player or an embedded page becomes a
link to what it showed, when that is on the web.

## Alternatives considered

**ProseMirror's own `DOMParser` with the editor's schema,** which is what a
paste goes through. It drops what the schema has no place for without saying
so, keeps a layout table as a table and a data URI in the document, and drops
tasks written as checkboxes. ADR 0029 turned it down for the first reason.

**Convert to Markdown and read that,** with a library such as Turndown. One
reader instead of two, but Markdown cannot hold blocks in table cells, spans,
or underline, and every word would be escaped only to be unescaped.

**parse5, which needs no DOM.** It would let the tests run without jsdom, but
ships a second HTML parser beside the one the webview has. jsdom is only a
development dependency, and parses with parse5, so the tests read a page the
way the standard says.

**Keep only the article,** as reader views do. It guesses, and a wrong guess
loses words with no sign of it. Deleting a menu from a note is easy.

**Read style sheets.** Emphasis given by a class would come across, at the cost
of laying the page out, which means putting it on a page.

**Decode in the webview,** whose `TextDecoder` knows the same encodings.
Nothing new to ship, but the bytes would cross IPC, and deciding what is text
is Rust's in ADR 0029.

## Consequences

A saved web page brings its menus and footers with it as lists and links. Text
emphasised only through a style sheet comes in plain.

Pictures beside the file or on the web do not come in, as for Markdown. The
8 MB cap on a file still holds, so a page saved with many photographs inside it
can be refused.

An imported note's pictures are stored before the note is, so an import that
fails between the two leaves pictures no note refers to. Collecting
unreferenced attachments takes those.

Rust gains `encoding_rs`. The tests gain jsdom, held at 26 because CI runs
Node 20 and the latest needs 22.
