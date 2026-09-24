# 0028: Open documents for reading, and make editing a choice

- **Status:** Proposed
- **Date:** 2026-09-24
- **Extends:** [0015](0015-the-url-is-the-open-document.md), [0017](0017-a-cross-document-todo-index.md)

## Context

Every note and journal opened straight into the editor, with the toolbar
above it and the caret one tap away. Most opens are to look something up,
and on a phone the tap that scrolls a note is also the tap that puts the caret
in it and brings the keyboard up. A stray one changes the note. The request
was for a reading mode: the document without any editing tools, where nothing
can be changed, as the default whenever a note or a journal is opened, with a
way to switch between reading and editing.

That leaves six things to decide: what reading is made of, what it still
allows, where the switch lives and what it remembers, whether anything opens
straight into editing, what becomes of features that put the caret somewhere,
and whether ticking a task counts as editing.

## Decision

**1. Every open starts reading,** notes and journals alike, however the
document is reached: the sidebar, a link, search, the calendar, an index, a
todo, the back button, a reload, or the app starting on today's journal.
Opening a different document, or coming back to one, starts it reading again.

**2. Reading is the same editor, made read-only,** not a second renderer.
Links, tags, images from the attachment store and every other node view look
exactly as they do while editing, a peer's edit still lands live, and
switching keeps the reader's place, because nothing is rebuilt. The editor is
always built editable and switched straight after: the table extension decides
at construction whether columns can be resized, and an editor built read-only
would never offer it.

**3. Reading allows reading, and nothing that changes the document.** There
is no toolbar. Typing, pasting, dropping, the slash menu, image resize handles
and tick boxes do nothing. Links are still followed, text can still be
selected and copied, and a screen reader is told the text box is read-only.
An empty document says to press Edit, instead of "Start writing...", which
would invite typing that does nothing.

**4. The switch is a button beside the sync indicator, and it remembers
nothing.** It reads Edit while reading and Done while editing, in the accent
colour, and on a phone it shows only its pencil or tick, so a long title
keeps its room. Mod-Shift-E does the same from the keyboard; Mod-E already
means inline code. The choice belongs to the document on screen: it is not a
setting, not kept per document, not synced, and not in the URL.

**5. A note just created opens for editing.** Creating one in the New note
dialog is asking to write in it, and reading an empty page whose only action
is Edit would be a step for nothing. The dialog asks for it just before
opening the note, and the next open uses the request up, so it never outlives
the navigation it was made for. Journals, including one the calendar creates
for a day, open for reading like everything else.

**6. A jump from the todo index lands on the item without a caret.** It
scrolls the item into view, lights it up for two seconds, and moves the
selection there, so pressing Edit puts the caret on it. Switching to editing
puts the caret wherever the selection is, which is where the reader last
clicked, but only when that is on screen; otherwise it waits for a click, so
the page does not jump away from what was being read.

**7. Ticking a task is editing.** The request was for a mode where nothing
can be changed, and a tick is a change that syncs to every device. Tick boxes
show their state and do not respond.

## Alternatives considered

**A separate read-only view,** the document rendered to HTML. Rejected: it
would draw links, tags and images its own way and drift from the editor, a
peer's edit would not appear until a reload, and switching would lose the
place.

**Rebuilding the editor for each mode.** Rejected for the same lost place and
reload, when the one real obstacle, table resizing, is met by building it
editable.

**Remembering the mode,** per document, per device or as a setting. Rejected
as against the request, which was for reading every time. A setting for the
default is easy to add later if reading every time turns out to be too much.

**The mode in the URL.** Rejected: a reload or the back button would reopen a
document for editing, which is exactly an open that should read. The URL says
which document is open (ADR 0015), not how.

**Opening an empty document for editing.** Rejected: today's journal is empty
every morning, and the request named journals.

**Opening a todo jump for editing,** which is what putting the caret on an
item amounted to before. Rejected to keep one rule for every open; the light
and the selection keep the jump useful, one press of Edit from where it was.

**Tick boxes that work while reading,** which the editor supports directly.
Deferred: it is the most likely of these to be revisited, since ticking off a
day's tasks is common, and it would be a small change on top of this one.

**Tap to edit,** where touching the text starts editing there. Rejected: that
is the stray tap this exists to stop.

## Consequences

- Writing takes one more step. Every morning's journal needs Edit before the
  first word, and the placeholder says so.
- Read-only means the reader cannot change the document, not that it cannot
  change. A peer's edit and the one-off image address migration both still
  write to a document being read.
- The caret is placed from an effect that runs just after the tap on Edit,
  not in the tap's own handler. That was checked in a desktop browser only.
  Phones, iOS especially, are stricter about focus outside a user gesture; if
  the keyboard does not come up there, a tap on the text still places the
  caret, as it always did.
- The editor being built editable before it is made read-only is load-bearing
  for table resizing. A future extension that decides something at
  construction from `isEditable` needs the same care.
