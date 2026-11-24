# 0043: Show HTML code blocks as pages while reading

- **Status:** Proposed
- **Date:** 2026-11-24
- **Extends:** [0028](0028-open-documents-for-reading.md), [0038](0038-draw-mermaid-diagrams-while-reading.md)

## Context

A note can hold a page's HTML only as its code. ADR 0042 turns an HTML file
into an editable note, which keeps what a page says and not how it looked. The
request was to see HTML as the page it makes.

A Mermaid diagram is already drawn from a code block while reading (ADR 0038),
and the same shape fits: the document holds code, and reading shows what it
makes. Three things are different. HTML is far more hostile than a diagram's
definition, and no sanitiser in the app reads it. A block of HTML is as often
there to be read as code as to be seen. And a page has links, a width it was
made for, and a height of its own.

## Decision

**1. Decorations on `html` code blocks, while reading.** As for Mermaid: a
widget before the block, and a class that hides the code when the page is
shown. Editing, it is code like any other. The schema, the document, sync,
export and MCP do not change, and a device on an older version shows the code.
Only `html` counts, trimmed and in any case, and an empty block shows nothing.

**2. A whole page shows as the page, and a piece of one as its code.** A block
that begins with a doctype or an `<html>` tag was put there as a page. Anything
else shows its code. A button on every block switches it, and Full size shows
it over the note. The choice is the editor's for as long as the note is open,
by what the HTML is, and is not stored.

**3. The page is in a sandboxed frame, held three ways.** The frame's sandbox
allows nothing but the app's origin, so no script, form, popup, download or
navigation of the app. `srcdoc` makes the page inherit the app's content
security policy. And the page begins with a policy of its own that allows its
own styles and the pictures inside it and nothing else. Each alone stops a
script the page brings; the app's policy alone would let it name one of the
app's own files. The app's policy is unchanged.

The page keeps the app's origin so that the app can measure it and reach its
links. That is safe only while nothing in the frame can run:
`allow-scripts` must never be added beside it, and a test says so.

**4. Nothing the page names is loaded.** A `<base>` of `about:srcdoc` comes
before anything the page says. A relative address, which would otherwise be one
in the app, resolves to nothing, and an address within the page still works.

**5. Links within the page work, and links out of it do not open.** Followed in
the frame, one is refused by the policy, and Chromium then shows its own error
in place of the page. Each is aimed at a new window, which the sandbox refuses
without a trace, and shows its address on hovering. The `<base>` does the same
for the moment before the page has loaded.

**6. A preview is as tall as its page, up to 480 pixels,** and scrolls after
that. It is measured at 480 pixels, so a page that is as tall as its window is
a window's height rather than nothing, and again only when its width changes.
Its background is white, as a page that sets none expects, in every scheme.

**7. Looking for text shows the code of the block it is in,** whatever was
chosen, since the match is in the code and would be out of sight.

## Alternatives considered

**A shadow root and a sanitiser.** DOMPurify is in the tree through Mermaid.
Links would work and no frame would take the keyboard, but the only thing
between a hostile note and the app would be the sanitiser, and a page's own
`body` styles, viewport units and media queries would not mean what they say.

**A sandbox that allows nothing, not even the origin.** The page could not be
measured, so every preview would be one height, and its links could not be
disarmed.

**Letting a page's scripts run.** It would have to be served from an origin of
its own, with a policy of its own, which no platform gives a Tauri frame in the
same way: on Linux and Android a call from a frame is not told apart from one
from the app, and on Windows the app's startup scripts are put into every
frame.

**Opening links in the browser.** It means hearing a click in the frame, and
WebKit runs no listener, even the app's own, in a frame that cannot run
scripts. Allowing popups and catching them in Rust would work on some platforms
and open bare windows on others. Watching the frame for a change a click makes
would work everywhere and leaves a step in the history for each link.

**A language of its own for a page, such as `htmlpage`.** It would make the
choice part of the note, at the cost of a language no other app knows, and no
colours for the code.

**Keeping HTML files as attachments.** Right for pages of many megabytes. It
changes the attachment store, which takes pictures only on purpose, and what
sync, backup and export do with it. A block is in the note's text, so it is
searched and synced like the rest, and so is held to what a note can be.

## Consequences

- Clicking in a preview gives it the keyboard, so the app's shortcuts, and
  Escape in the full-size view, wait for a click outside it. The close button
  always works.
- A page that builds itself with scripts shows as it was before they ran.
- Pictures and fonts on the web are missing from a page.
- Following a link within a page adds a step to the history, as it does in a
  browser, so going back takes one more.
- What is shown depends on WebKit and Chromium agreeing about sandboxed frames.
  Both were tested, in WebKitGTK 2.52 and Chrome. WKWebView, WebView2 and
  Android's WebView were not.
