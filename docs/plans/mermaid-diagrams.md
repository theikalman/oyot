# Plan: draw Mermaid diagrams while reading

A code block whose language is `mermaid` shows as the diagram it describes
when the note is open for reading. Pressing Edit brings back the code, so the
diagram is changed the way any code block is.

Every platform the app runs on: desktop and phones.

## Status (2026-10-22)

Merged in #77 and released in 0.0.32-alpha, recorded in ADR 0038. Differences from the
plan below:

- `mermaid@12.1.0`, not 12.2.0, which was less than two weeks old.
- Peer edits wait 150 ms before drawing, not 200 ms.
- The first pie slice takes the accent colour, and labels on lines take the
  page background, so both read in every scheme.

Checked in a browser under the app's content security policy: flowchart,
sequence, class, state, ER, gantt, pie and mindmap all draw, with no
violation. Mermaid is in its own chunk, loaded by a dynamic import.

Still to do before ADR 0038 is accepted:

- The same check on Android. On Linux, `make dev` draws a real note's
  diagrams on opening and again after Edit then Done.
- The APK size change.
- Jumping to a todo below a diagram, tried by hand.

## What already works

- A code block keeps its language in the `language` attribute of StarterKit's
  `codeBlock` node.
- Typing ` ```mermaid ` and a space or Enter in the editor makes a code block
  with that language. StarterKit's input rule does this.
- Markdown import reads the fence's info string into `language`
  ([import/markdown.ts](../../src/lib/import/markdown.ts), `codeBlock`), and
  export writes it back ([export/markdown.ts](../../src/lib/export/markdown.ts),
  `codeBlock`). A Mermaid block from Obsidian, GitHub or the MCP tools already
  round-trips.
- Reading is the same editor with `setEditable(false)` (ADR 0028,
  [EditorInstance.svelte](../../src/lib/editor/EditorInstance.svelte)). Switching
  modes reconfigures the view, which redraws its decorations.

So nothing in the document model changes. This is display only.

## Decisions

**1. Decorations, not a node view.** A live-editor-only extension,
`MermaidDiagrams`, adds a ProseMirror plugin whose `decorations` prop returns:

- for each `codeBlock` with a Mermaid language, while the editor is not
  editable:
  - a node decoration that puts the class `mermaid-source` on the `<pre>`, so
    the stylesheet can hide it;
  - a widget decoration just before the block (`side: -1`) that holds the
    diagram;
- nothing while editing.

Why not `codeBlock.extend({ addNodeView })`:

- `createContentExtensions()` is the schema that the sync layer and the
  headless index share, and it has to load where there is no DOM (see the
  comment in [extensions.ts](../../src/lib/editor/extensions.ts)). Rendering
  belongs with the interaction extensions in `EditorInstance.svelte`.
- A node view would take over how every code block is edited, and editing
  code has to stay exactly as it is now.

**2. Which languages count.** `mermaid`, matched after trimming and ignoring
case. Nothing else: `mmd` is a file extension, not a fence language that other
apps write.

**3. Mermaid is loaded only when needed.** `import('mermaid')` runs the first
time a widget is drawn. Notes with no diagram never pay for it. Vite splits it
into its own chunk, and Mermaid splits each diagram type further.

**4. Strict security.** `securityLevel: 'strict'`, `startOnLoad: false`. Notes
arrive from paired devices and through MCP, so a diagram is untrusted input:
no click handlers, no HTML in labels, and Mermaid's DOMPurify runs over the
output. The SVG is put in with `innerHTML` only after that.

**5. Colours come from the scheme.** Mermaid's `base` theme, with
`themeVariables` read from the root element's computed CSS variables
(`--bg-primary`, `--bg-secondary`, `--text-primary`, `--border-light`,
`--accent-color`, `--code-bg`). Every scheme then gets a matching diagram
without a mapping per scheme (ADR 0036). `darkMode` comes from
`data-theme`.

**6. Cached by source and scheme.** The widget's `key` is
`mermaid:<scheme>:<hash of source>`. ProseMirror keeps the existing DOM for an
unchanged key, so redraws for unrelated changes (a tick while reading, a
peer's edit elsewhere) don't flicker. A module-level LRU of about 50 rendered
SVGs, keyed the same way, makes reopening a note instant.

**7. Errors show the code.** If Mermaid can't parse the source, the widget
shows a short line ("Couldn't draw this diagram: <first line of the error>")
and the source in a `<pre>`. A typo never makes a block disappear.

## Implementation

### Step 1: the dependency

- `npm install --save-exact mermaid@12.1.0` (at least two weeks old when
  this lands).
- Nothing in `vite.config.js` should need to change. Check after a build that
  `mermaid` is in its own chunk and not in the entry chunk.

### Step 2: pure helpers, `src/lib/editor/mermaid/blocks.ts`

DOM-free, so the node test environment can cover them:

- `isMermaidLanguage(language: unknown): boolean`
- `findMermaidBlocks(doc: ProseMirrorNode): Array<{ pos: number; end: number; source: string }>`
- `diagramKey(scheme: string, source: string): string`, using a small
  non-cryptographic string hash (FNV-1a is enough)

### Step 3: rendering, `src/lib/editor/mermaid/render.ts`

- `loadMermaid()`: one shared promise around the dynamic import and
  `mermaid.initialize(...)`. Initialize again when the scheme changes.
- `renderDiagram(source, scheme): Promise<{ svg: string } | { error: string }>`,
  which:
  - checks the LRU first;
  - calls `mermaid.render(uniqueId, source)` (ids from a counter, since
    Mermaid adds a temporary element by that id to the body);
  - catches parse errors and returns them as values.
- `themeVariablesFromCss()`: reads the computed variables listed in decision 5.

### Step 4: the extension, `src/lib/editor/mermaid/MermaidDiagrams.ts`

- `Extension.create({ name: 'mermaidDiagrams', addProseMirrorPlugins() { ... } })`
- The plugin's `decorations(state)` returns `DecorationSet.empty` while
  `editor.isEditable`. Otherwise it maps `findMermaidBlocks(state.doc)` to the
  two decorations in decision 1.
- The widget's `toDOM`:
  - creates a `div.mermaid-diagram` with `role="img"`, an `aria-label` (the
    diagram's `accTitle` if it has one, otherwise "Diagram") and
    `contenteditable="false"`;
  - shows a placeholder sized like the code block it replaces, so the page
    jumps less when the SVG arrives;
  - starts `renderDiagram` and fills the element in when it resolves, if the
    element is still connected.
- Widget spec: `ignoreSelection: true`, and `stopEvent: () => false` so
  clicking a diagram behaves like clicking any other read-only content.
- Scheme changes: in `view()`, a `MutationObserver` on
  `document.documentElement` for `data-scheme` dispatches an empty
  transaction with a meta flag, so the decorations rebuild under the new key.
  Disconnect it in `destroy()`.
- A peer typing in a diagram's code while it is being read gives a new key on
  every keystroke. Debounce the render inside `toDOM` by about 200 ms, so only
  the last version is drawn.

### Step 5: wire it in

- Add `MermaidDiagrams` to the interaction list in
  [EditorInstance.svelte](../../src/lib/editor/EditorInstance.svelte), next to
  `TickWhileReading`.
- Styles in the same component's `<style>`:
  - `.editor-content.read-only :global(pre.mermaid-source) { display: none; }`
  - `.mermaid-diagram`: same margin as `pre`, `overflow-x: auto`, centred SVG
    with `max-width: 100%; height: auto;`
  - error state: `--text-secondary` for the message, the code in normal `pre`
    styling.

### Step 6: check the Tauri build

The CSP in `src-tauri/tauri.conf.json` allows `style-src 'unsafe-inline'`,
which Mermaid's inline `<style>` in the SVG needs. `script-src` has no
`'unsafe-eval'`. Mermaid shouldn't need it, but this has to be checked in
`npm run tauri build`, not only in `vite dev`, for:

- flowchart, sequence, class, state, ER, gantt, pie and mindmap;
- one desktop OS and Android.

If a diagram type needs something the CSP blocks, list it as unsupported. The
CSP stays as it is.

### Step 7: docs

- ADR 0038, "Draw Mermaid diagrams while reading", covering decisions 1 to 7.
- One line in the README's feature list and in the in-app help.
- The changelog entry in `src/lib/changelog.ts`, which goes in with the
  version bump.

## Tests

Unit (vitest, node environment):

- `isMermaidLanguage`: `mermaid`, `Mermaid`, `mermaid`, `null`, `js`,
  `mermaidx`.
- `findMermaidBlocks` on documents built from `createContentExtensions()`:
  - none;
  - one;
  - several among other code blocks;
  - one nested in a list item or a blockquote;
  - an empty Mermaid block, which gets no widget.
- `diagramKey`: the same for the same source and scheme, and different when
  either changes.
- Round trip: a Mermaid fence imported, then exported, gives the same
  Markdown. This may already be covered in `roundTrip.test.ts`; if it isn't,
  add a case.

By hand, in the Tauri app:

- Open a note with a diagram: it shows as a diagram. Press Edit: it shows as
  code. Press Done: it shows as a diagram again.
- An invalid diagram shows the error line and its code.
- Change the colour scheme while reading: the diagram follows.
- A paired device edits the diagram while this one is reading: it redraws once
  typing stops.
- A note with no diagram: the Network/Sources panel shows no Mermaid chunk
  loaded.
- Jump to a todo below a diagram (`focusTodo`): it lands on the right line
  after the diagram has drawn. If it doesn't, scroll again once pending
  renders settle.
- Phone width: a wide diagram scrolls sideways inside its box, not the page.

## Out of scope, for later

- Drawing diagrams while editing when the caret is outside the block.
- A slash command, "Diagram", that inserts a Mermaid block with a starter
  flowchart.
- A way to change an existing code block's language from the toolbar.
- Diagrams in exports other than Markdown (Markdown keeps the code, which is
  what other apps expect).
- Other text-to-diagram languages (PlantUML, Graphviz).

## Risks

- **Bundle size.** Mermaid adds a few MB of chunks to the app bundle, though
  none of it loads until a diagram is shown. Acceptable for a desktop app.
  Check the APK size change on Android.
- **Layout shift.** Diagrams draw asynchronously, so anything that measures
  positions on open (the jump target, a restored scroll position) can be off
  by the difference in height. The sized placeholder makes this smaller; step
  4 notes where to correct it.
- **Mermaid upgrades.** A major version can change how a diagram is laid out,
  or drop syntax. Pin the version exactly and upgrade on purpose.
