# 0015: The URL says which document is open, and the shell owns startup

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

The app had one real route. `/` rendered the whole workspace, `/settings`
and `/settings/sync` were siblings, and which document was open was held in a
Svelte store and nothing else.

Two problems followed from that, and they were the same problem.

**Startup belonged to a page.** The workspace page's `onMount` loaded the
document list, opened today's journal, and ran the orphan-image pass. Settings
is a sibling route, so going there unmounted the workspace and coming back
re-ran all of it: the list reloaded, today's journal was re-announced to every
peer (and each peer answered by pulling the whole document back), the loading
overlay flashed, and the user was returned to the journal rather than the note
they had been reading. The same applied to the design tokens, which lived in
that page's `:global` block, so settings rendered with none of them defined.

**The open document had no address.** There was no history, so no back button
and nothing for Android's hardware back key to do except exit the app from the
only route there was. There was no way to link to a note, which the editor
needs internally: `Backlinks` and the document-link node view could not reach
the store, so they opened documents by dispatching a `window` custom event
that the editor listened for. Six places set the current document, three of
them by fetching it first.

## Decision

**1. The workspace moves to `/doc/[id]`.** The URL is the single statement of
what is open. The route loads the document and sets the store; nothing else
does.

**2. `/` is an entry point, not a page.** It resolves today's journal and
navigates, with `replaceState`, so the back button never lands on a redirect.

**3. Opening a document is a navigation**, through one helper. The custom-event
bus is deleted, and creation no longer opens what it created: the caller
navigates.

**4. The layout owns startup**, as a memoised promise. It is the only component
mounted for the app's lifetime. The entry route awaits the same promise,
because both need the document list and the order between them matters.

**5. The layout owns the theme** for the same reason. It was applied only by
the workspace page, so the toggle on the settings page did nothing visible
until the user navigated back.

## Alternatives considered

**Put the document in a query parameter, `/?doc=<id>`.** Same history and
back-button behaviour with only one route, and no dependence on how the host
serves unknown paths. Rejected once it was confirmed that Tauri falls back to
`index.html` for a path it has no asset for, which is what makes a reload on
`/doc/<id>` resolve. A path is the honest shape for "this is a document", and
the fallback is a property of the host rather than a trick.

**Make settings a modal over the workspace.** The cheapest fix for the
remount, and it was tempting because settings is the only other screen.
Rejected: it addresses the remount and nothing else. The app would still have
no URL for a document, no history, and no answer for the hardware back key.

**Keep the store as the source of truth and mirror it into the URL.** Less
disruptive, since the six call sites could stay. Rejected: two sources of
truth that have to be kept in step, and the store would still be the one that
actually decided, so a back navigation would have to be translated into a
store write anyway.

**Guard startup with a boolean instead of a promise.** Simpler to read.
Rejected: a boolean says the work has begun, not that it has finished, and the
entry route needs the second thing.

## Consequences

- A document can be linked to, the back button works, and Android's back key
  navigates instead of exiting.
- Going to settings and back keeps the note you were reading, costs no
  reloads, and tells no peers anything.
- The app now depends on the host serving `index.html` for an unrecognised
  path. Tauri does; a different host would need its own fallback configured,
  and the static adapter is already set up with one for the dev server.
- A document id appears in the URL. Ids are opaque for notes and the date for
  journals, so nothing sensitive is exposed, but it is worth remembering that
  a journal's URL states its date.
- One more module, and one more thing to remember: creating a document does
  not open it. That is the point, but it is a change of habit.
