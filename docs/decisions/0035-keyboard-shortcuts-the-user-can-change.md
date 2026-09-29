# 0035: Keyboard shortcuts the user can change, kept per device

- **Status:** Proposed
- **Date:** 2026-09-29
- **Extends:** [0028](0028-open-documents-for-reading.md)

## Context

Every shortcut was fixed: the editor's formatting keys came with Tiptap's
extensions, and the app's two, Mod-/ for Help and Mod-Shift-E for Edit (ADR
0028), were written into the layout and the document page. The request was a
setting where the user can replace a default shortcut with one of their own.

Most of the keys are not the app's to change in one place. Every Tiptap
extension carries its own key bindings, a keymap plugin each, and the editor
checks them in order until one answers. Their order is not the list's: later
extensions come first, and a binding for a capital, such as bold's `Mod-B`,
also answers the same key with Shift held. So new keys cannot just be handed
to the editor, and taking a key away from one extension has to stop every
other extension answering it too.

That leaves seven things to decide: which shortcuts can be changed, what they
can be changed to, what cannot be used, where the choice is kept, what
happens when two shortcuts want one key, how the editor is made to answer
them, and where the keys in use are shown.

## Decision

**1. A shortcut can be changed when it does one thing wherever it works.**
Help, switching between reading and editing, the five text styles, the six
headings and normal text, the three lists, quote, code block, undo and redo.
Enter, Tab, Shift-Tab, Shift-Enter, Mod-Enter, the arrows, Escape and the
`/` of the insert menu keep their keys: each does different things in
different places, in a list, a table, a code block, a menu, and they are
listed on the help page as they are. Each shortcut that can be changed has a
stable id in `$lib/keyboard/shortcuts`, shared with its toolbar tool where
there is one.

**2. A shortcut is Mod, or Control on an Apple device, with a letter, digit
or symbol,** and Option (Alt) and Shift if wanted. Holding Mod means a
shortcut never types, and a character key keeps clear of the keys in
decision 1. A letter or digit is recorded by which key it is, as the
editor's own keymap reads one, so Command-Shift-8 is `Mod-Shift-8` rather
than `Mod-Shift-*`, and a Russian keyboard's и is b. A symbol is recorded as
it is typed, so a German keyboard's ö is ö.

**3. Some keys are kept.** Everywhere, copy, cut, paste and select all. On an
Apple device, the keys the app's own menu gives Quit, Close Window, Hide,
Hide Others, Minimize and full screen, because the web view sees a key press
before the menu does, and a shortcut on ⌘Q would have stopped Oyot quitting;
and the editor's Control keys for moving to either end of a paragraph and
deleting a character, which every Mac text field has. A test lists every key
the editor binds, on a Mac and elsewhere, and fails for any a user could
press as a shortcut that is neither the default of one that can be changed
nor kept, so no key can be taken from the editor without meaning to.

**4. The keys are kept per device, in `config.json`, as overrides.** Only the
shortcuts the user changed are stored, each with the keys it has instead,
possibly none; every other shortcut keeps its own, so one added later
arrives with its keys. They are not synced, as the theme is not: a Mac and a
PC keyboard want different keys, and Control means something different on
each. Rust checks only the shape of what is stored, since which ids and keys
mean anything is the page's to know, and it keeps ids it does not recognise,
for a later version that does.

**5. No two shortcuts share keys.** Keys given to one are taken from
whichever had them, and that is stored as a change to it too, so what a key
does never depends on the order shortcuts are read in. Taking keys is asked
about first, naming the shortcut that would lose them and what it would
keep. Reset gives a shortcut its own keys back through the same step, and
asks the same way if something else has them by then. A shortcut given its
own keys back stores nothing, so resetting them all empties the file's entry.

**6. The editor answers changed shortcuts from one extension in front of all
the others.** `CustomShortcuts` sits at priority 10000, ahead of every
extension's bindings, the collaboration binding's undo and redo included. A
changed shortcut's keys run the command its own binding runs, whether or not
it can run there, so the press never falls through to a binding that shares
the key's name. A shortcut's old keys do nothing, matched by the editor's
own rules so they catch everything its binding would have. Keys of a
changed Help or Edit are taken on their way to the window, which answers
them, so no binding of the editor's gets them first. While nothing is
changed it answers nothing, and the editor is exactly what it was. The
layout answers Help and the document page Edit by asking whether a press is
that shortcut now.

**7. Wherever a shortcut is named, it is named with the keys it has now:**
the toolbar's tooltips, the Edit button's, the sidebar's Help button's, and
the help page, which says "No shortcut" for one left without and points to
Settings > Keyboard shortcuts, where they are changed.

## Alternatives considered

**Building the editor with the user's keys,** by configuring or extending
each extension. Rejected: the keys are not options on most of them, so each
would have to be taken out of StarterKit and put back extended, in the one
list of extensions that also defines the schema the sync layer reads
documents with (ADR 0013). A mistake there changes what a document is made
of, not just what a key does. The editor would also have to be rebuilt for
every change, losing the reader's place.

**Any keys at all,** a letter on its own, F-keys, Enter with a modifier.
Rejected: a letter types, F-keys are media keys on a Mac, and the keys in
decision 1 already mean something in the editor.

**Syncing the keys,** so a change is made once. Rejected in decision 4. A
setting that moved from a Mac to a PC would mostly work, since Mod follows
the platform, but a Mac's Control keys would land on keys that already mean
Mod.

**Keeping the keys in localStorage.** Rejected for the reason the theme is
kept in Rust: a web view's storage can be cleared or not persist, and the
theme treats it as a cache only.

**Letting two shortcuts share keys,** with a warning. Rejected: one press
would do two things, or whichever the editor happened to check first.

**Several keys for a shortcut from the page,** as Redo has two of its own.
Not now. The stored form is a list, so a later version can add it without a
migration.

**Carrying the keys in backups,** which carry the theme. Not now: it changes
the backup format and what a backup's fingerprint covers, and a backup
restored onto another platform has the problem syncing does.

## Consequences

- A shortcut added in a later version whose default is a key the user has
  given something else starts with no keys, since the user's choice wins.
  It shows as changed, and Reset asks before taking the key.
- The layer runs the same commands as the editor's own bindings, and a test
  runs both on an editor that notes what it is asked and compares them, so
  a Tiptap upgrade that changes a binding's command fails there.
- Changed keys are matched by the app's own rules, which follow the editor's
  keymap except in one case: on a Mac with Command and Shift held, the
  editor's keymap reads the key by its American name and the app reads what
  it types. The old keys of a changed shortcut are matched by the editor's
  own rules, so one never leaks through to its old binding.
- Keyboards other than American are covered by unit tests with the key
  codes browsers send, not by real ones. The page was tried in a desktop
  browser, whose simulated key presses carry no key code, and not yet in
  the WKWebView, WebView2 or Android web views with a physical keyboard.
