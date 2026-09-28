# 0029: Import Markdown files as notes, read in Rust and built in the webview

- **Status:** Proposed
- **Date:** 2026-09-28
- **Extends:** [0013](0013-derived-rows-are-built-wherever-content-arrives.md), [0019](0019-tags-as-inline-nodes-with-one-spelling.md), [0021](0021-export-notes-as-a-markdown-archive.md)

## Context

Notes could leave Oyot as Markdown (ADR 0021) but could not come in. The
request was to import notes, Markdown files only for now, each becoming a
regular note.

The constraints are the export's, in the other direction. A document can only
be built where the schema is, and the schema is in the webview (ADR 0013). The
webview has no filesystem permission and must not get one: it renders content
that arrives from paired devices, so a script there must never be able to
name a file on disk. And Markdown is not one format. The exporter writes a
note's title in front matter and again as a heading, and its tags in front
matter and in the words; Obsidian keeps tags in front matter alone; many
editors keep the title only in the file's name; GitHub adds tables, task lists
and strikethrough; and almost every file can hold HTML and images that live
beside it.

## Decision

**1. Rust picks and reads the files; the webview builds the notes.** One
command, `pick_markdown_files`, opens a multi-file dialog and hands back each
file's text and name, nothing else. No path crosses IPC in either direction.
A file becomes text only when it is UTF-8 (with or without a byte order mark)
or UTF-16 with one, and holds no NUL; anything else is reported by name as not
text rather than guessed at. The caps are backstops: 8 MB a file, the
export's cap on a note, so a note exported can always come back; and 5,000
files or 128 MB in one import, past which the whole pick is refused rather
than imported in part. Desktop filters on Markdown's extensions; phones get no
filter, as for a backup, because Android matches by MIME type and file
managers disagree about Markdown's.

**2. Each file becomes a regular note, made the way the editor makes one.**
`createNote`, unpinned, then the content saved through
`DocumentRepository.saveLocalUpdate` and broadcast as a local update, so an
imported note is indexed, counted, searchable and sent to paired devices
exactly as a typed one is. Its CRDT is made from the built document with
y-tiptap's `prosemirrorToYDoc`, which is the documented way to bring content
that has never been in an editor into Yjs. The note is created at the moment
of import, like any new note.

**3. markdown-it parses, and a reader of its tokens builds nodes against the
editor's schema directly.** CommonMark, plus GitHub's tables, strikethrough,
task lists and bare links. Building nodes rather than HTML means the result is
a document the editor could have made, or an error, and never something the
schema quietly trimmed. The reader lives beside the exporter's serializer and
mirrors it, and reading an export back gives the exported document back; the
tests check that through the exporter in both directions. The reader and
markdown-it load only when an import starts.

**4. A note's title is the front matter's, else a heading that opens the
file, else the file's name, else "Untitled".** A heading at the top that gave
the title, or repeats the front matter's, is taken out of the content: a note
shows its title above its content and would otherwise open with its own name
twice. A heading that says something else stays.

**5. `#name` becomes a tag when the `#` begins a word and the name has a
letter in it.** So `C#`, `issue #42` and `page/#anchor` stay text, and
`**#urgent**` and `(#home)` are tags. The characters are the ones Obsidian and
Bear allow. Names the front matter lists are matched first, which is how a tag
with a space in it survives: the exporter writes it as `#house move` and lists
it. Front matter tags that the words do not carry go at the top of the note as
a line of chips, since a tag is a chip in the text and there is nowhere else
to keep one (ADR 0019). From an Oyot export that adds nothing. Every other
front matter key is left behind.

**6. A link to another file in the same import becomes a link to its note.**
Every note is created before any is filled in, so each has an id by the time
the links are built. Links match by file name, which is what a relative link
names; a name two files share links to neither. Every other link stays a link.

**7. What a note cannot hold stays as the text it was written as.** HTML is
kept as text, except `<br>`, which is a line break. An image is kept as an
image when it is an inline raster data URI, which the editor shows, or when
it names an attachment by its content hash, as `oyot-attachment://` and the
exporter's `attachments/<hash>.<ext>` files do; it then shows as soon as this
device, or one it syncs with, holds the bytes. Any other image, a file beside
the note or a web address, is kept as its Markdown, `![alt](path)`, where it
stood. Nothing in a file is dropped by being imported, and the summary counts
what came in as text.

**8. A file that fails is named, and the rest continue.** The summary names
the files skipped and why, and counts the images kept as text and those
naming attachments this device does not hold. A note whose content could not
be saved is deleted again rather than left empty under its title.

## Alternatives considered

**Read the images beside a file.** The most wanted thing this leaves out, and
the one with a security question in it. Having the webview pass the paths it
found would let the webview name files, which is the thing the security
model rules out. Having Rust find the paths itself, in the files the user
picked, would let a downloaded Markdown file reach any image the user can
read, `../../Pictures/…`, and put it on every paired device. A folder the user
picks bounds that, but phones cannot pick one. Importing the export's zip,
where every path resolves inside the archive, is the likely next step; this
ADR does not decide it.

**`@tiptap/markdown`.** The official route, with Markdown rules declared on
each extension. It would still need rules of its own for tags, document links
and attachment images, its HTML handling needs a DOM, and it decides for
itself what to keep. The exporter is hand-written for the same reasons, and
the importer mirrors it.

**Render Markdown to HTML and parse that with the schema.** Needs a DOM, so
not in the tests, and HTML parsing drops whatever the schema has no place for
without saying so, which is the opposite of decision 7.

**Parse in Rust.** Rust holds the files, but not the schema. ADR 0021 turned
down rendering Markdown there for the same reason.

**Keep the dates a file carries.** Front matter says `created` or `date` or
nothing, a file's own modification time says when it was last copied, and a
note dated years ago lands deep in the Notes list, where nobody finds it just
after importing it. An imported note is new here.

**Import into the note with the same id.** The exporter writes each note's id,
but content rebuilt from Markdown is new to the CRDT, so merging it into the
note it came from duplicates rather than restores. A backup (ADR 0024) is the
lossless way back.

**Keep the rest of the front matter as text.** It is another app's metadata,
and turning it into the note's content would be writing something the user
never wrote as content.

**Wiki links, `[[Note]]`.** Obsidian's, not Markdown's. They stay text. Linking
them to notes in the same import would use decision 6's lookup, and is a small
follow-up if wanted.

## Consequences

An export imported back comes back as the notes it was: titles, tags, links
between notes imported together, and images whose bytes this device or a
paired one still holds. What does not come back is what a copy cannot be: the
original ids, the dates, and the pins. What Markdown never carried, an image's
width and a table's column widths, is not there to come back either.

Images stored beside a file do not come in yet. They stay in the note as
their Markdown, visible, and the summary counts them.

A hex colour such as `#ff0000` becomes a tag, as it does in Obsidian; `#1984`
does not.

Reading an export back found a bug in the exporter: a list nested in a task
item was indented as far as the task's words, which every Markdown reader
takes for a code block. It is fixed alongside.

Notes are created last to first so the Notes page, newest first, lists a batch
in the order of the files' names. Two notes created within the same
millisecond tie, and the page breaks a tie by id, so that order is usual
rather than certain.

The reader and markdown-it are a 145 KB chunk, loaded when an import starts.
