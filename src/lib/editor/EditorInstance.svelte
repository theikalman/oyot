<script lang="ts">
    import type { Snippet } from 'svelte';
    import { onDestroy } from 'svelte';
    import type * as Y from 'yjs';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Editor } from '@tiptap/core';
    import { NodeSelection } from 'prosemirror-state';
    import { Plugin } from '@tiptap/pm/state';
    import Placeholder from '@tiptap/extension-placeholder';
    import { Extension } from '@tiptap/core';
    import { exitSuggestion } from '@tiptap/suggestion';
    import { SlashCommand } from '$lib/tiptap/SlashCommand';
    import { EmojiSuggestion } from '$lib/tiptap/EmojiSuggestion';
    import { closeAnyPicker } from '$lib/tiptap/pickerPopup';
    import { createContentExtensions } from './extensions';
    import {
        registerDocumentLinkCommand,
        registerDateCommand,
        registerTodoCommand,
        registerTagCommand,
        registerImageCommand,
        registerEmojiCommand,
    } from '$lib/tiptap';
    import { createCollaborationExtension } from './yjs';
    import { CONTENT_FIELD } from './contentField';
    import { REMOTE_ORIGIN } from './origin';
    import { unregisterOpenDoc } from './openDocs';
    import { locateTaskItem } from './taskItems';
    import { JumpTarget, markJumpTarget } from './jumpTarget';
    import { TickWhileReading } from './tickWhileReading';
    import { MermaidDiagrams } from './mermaid/MermaidDiagrams';
    import { CodeBlockLanguage } from './codeBlockLanguage';
    import { CustomShortcuts } from './customShortcuts';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { toasts } from '$lib/services/toast';
    import { documentRepository } from '$lib/sync';

    // A document being read is still announced as a text box, which is what
    // the editor is, so a screen reader is also told it cannot be typed into.
    const ReadOnlyState = Extension.create({
        name: 'readOnlyState',
        addProseMirrorPlugins() {
            const editor = this.editor;
            return [
                new Plugin({
                    props: {
                        attributes: (): Record<string, string> =>
                            editor.isEditable ? {} : { 'aria-readonly': 'true' },
                    },
                }),
            ];
        },
    });

    interface Props {
        document: any | null;
        onEditorReady?: (editor: EditorType, ydoc: any) => void;
        // Called with the outgoing document's id and ydoc immediately before
        // the editor behind them is destroyed, so a pending save can be
        // flushed while the state that produced it is still live.
        onBeforeTeardown?: (docId: string, ydoc: Y.Doc) => void;
        // Every local change to the document, as a Yjs update. Changes merged
        // from a peer are tagged REMOTE_ORIGIN and skipped: they are already
        // stored, and saving them again would only be work.
        onLocalUpdate?: (update: Uint8Array) => void;
        // Which of the document's task items to put the cursor on, counted
        // depth-first, as the todo index addresses one. Null for an ordinary
        // open, which leaves the cursor wherever the editor puts it.
        focusTodo?: number | null;
        // False to show the document for reading: nothing typed, clicked or
        // pasted changes it, except ticking a task off. A peer's edit still
        // lands, since that is the document changing rather than the reader
        // changing it.
        editable?: boolean;
        /** Drawn above the document, scrolling with it: a journal's day on a phone. */
        head?: Snippet;
    }

    let {
        document,
        onEditorReady,
        onBeforeTeardown,
        onLocalUpdate,
        focusTodo = null,
        editable = true,
        head,
    }: Props = $props();

    let element = $state<HTMLDivElement | null>(null);
    // What scrolls: the document and the head above it.
    let scroller = $state<HTMLDivElement | null>(null);
    let editor = $state.raw<EditorType | null>(null);
    let ydoc = $state.raw<any>(null);
    let isInitialized = $state.raw(false);
    let currentDocId = $state.raw<string | null>(null);
    let isLoadingEditor = $state.raw(false);

    async function initializeEditor() {
        const docId: string | null = document?.id ?? null;
        if (!element || !docId) {
            return false;
        }

        // Flush the document we are leaving before its ydoc goes away. This has
        // to happen here rather than in a sibling effect: the two effects race,
        // and if this one wins, the outgoing document's pending edit is lost.
        if (editor && ydoc && currentDocId) {
            onBeforeTeardown?.(currentDocId, ydoc);
        }

        // Stop the sync layer handing a peer's edit to a document we are about
        // to discard. Before the teardown below, so there is no window where a
        // merge could land on a Y.Doc nothing is reading any more.
        if (ydoc && currentDocId) {
            unregisterOpenDoc(currentDocId, ydoc);
        }

        cancelFocus?.();
        if (editor) {
            // A picker belongs to the editor it inserts into; see onDestroy.
            closeAnyPicker();
            editor.destroy();
            editor = null;
        }
        if (ydoc) {
            ydoc = null;
        }

        // Reads the stored state and registers this Y.Doc as the open copy in
        // one queued step. Loading from `document.crdt_state` instead would
        // reopen whatever was fetched when the user clicked, which a merge
        // since then has already made stale.
        const newYDoc = await documentRepository.openDocument(docId);

        const collabExt = createCollaborationExtension(newYDoc, CONTENT_FIELD);

        const ed = new Editor({
            element,
            extensions: [
                // The schema, shared with the sync layer so a document merged
                // from a peer is read the same way this editor renders it.
                ...createContentExtensions(),
                // Interaction, which only a live editor has any use for.
                // Collaboration declares priority 1000, so it leads the plugin
                // order wherever it sits in this list.
                collabExt,
                Placeholder.configure({
                    // The stylesheet only shows this on an empty document.
                    // Reading one, typing does nothing, so rather than invite
                    // it the placeholder says how to start.
                    showOnlyWhenEditable: false,
                    placeholder: ({ editor }) =>
                        editor.isEditable
                            ? 'Start writing...'
                            : 'Nothing here yet. Press Edit to start writing.',
                }),
                SlashCommand,
                EmojiSuggestion,
                ReadOnlyState,
                JumpTarget,
                TickWhileReading,
                MermaidDiagrams,
                CodeBlockLanguage,
                // The keys the user gave shortcuts, ahead of the editor's own.
                CustomShortcuts.configure({
                    bindings: () => customShortcuts.bindings,
                    command: customShortcuts.command,
                }),
            ],
            // No initial content. The collaboration binding replaces the
            // document with the Yjs fragment as soon as the editor is
            // constructed, so anything passed here was discarded before it
            // could be seen. A new document starts empty, which is what it
            // did in practice anyway.
            //
            // Always built editable, and made read-only straight after. The
            // table extension decides at construction whether columns can be
            // resized, and leaves resizing out for good in an editor built
            // read-only, so switching that editor to editing would have lost
            // it. Nothing runs in between that a reader could act on.
            editable: true,
        });
        // Opened for editing, which only a note just created is: the caret
        // goes straight in, so writing starts without a click.
        if (!editable) ed.setEditable(false);
        else placeCaretIfOnScreen(ed);

        ed.view.dom.addEventListener('click', handleImageClick);

        // These register into a module-level registry, not into `ed`. They
        // took an editor argument that none of them used.
        registerDocumentLinkCommand();
        registerDateCommand();
        registerTodoCommand();
        registerTagCommand();
        registerImageCommand();
        registerEmojiCommand();

        // The only thing that schedules a save. Tiptap's `onUpdate` used to do
        // it as well, which meant a peer's edit landing in this document
        // scheduled a save of the whole document.
        newYDoc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin === REMOTE_ORIGIN) return;
            onLocalUpdate?.(update);
        });

        ydoc = newYDoc;
        editor = ed;
        isInitialized = true;
        currentDocId = docId;

        onEditorReady?.(ed, newYDoc);
        return true;
    }

    // How long to keep looking for an item that is not there yet.
    const FOCUS_TIMEOUT_MS = 1500;
    let cancelFocus: (() => void) | null = null;
    // The document and item a focus has already been performed for, so a
    // re-render does not yank the cursor back out from under the user.
    let focusedKey: string | null = null;

    function focusTaskItem(ed: EditorType, ordinal: number) {
        cancelFocus?.();

        const attempt = (): boolean => {
            if (ed.isDestroyed) return true; // nothing left to focus; stop
            const target = locateTaskItem(ed.state.doc, ordinal);
            if (!target) return false;
            // Reading, there is no caret to put on the item, but the
            // selection still moves there, and Edit puts the caret wherever
            // the selection is. So the jump lands on the item either way,
            // one press of Edit later.
            const jump = ed.chain().setTextSelection({ from: target.from, to: target.to });
            if (ed.isEditable) jump.focus();
            jump.scrollIntoView().run();
            markJumpTarget(ed.view, target.pos);
            return true;
        };

        const onUpdate = () => {
            if (attempt()) finish();
        };
        const timer = setTimeout(() => {
            finish();
            // The note is open either way, which is most of what was asked
            // for. Say why the cursor did not move rather than leave it
            // looking like the click half-worked.
            if (!ed.isDestroyed) toasts.info('That item is not in this note any more');
        }, FOCUS_TIMEOUT_MS);

        // Not in this turn of the loop. Getting here is a navigation, and a
        // navigation scrolls the new page to the top on its way in, so
        // scrolling the item into view before that happens is undone a moment
        // later and the note sits at the top with the cursor somewhere off
        // screen. Focus is handled at the other end, by navigating with
        // `keepFocus`, which is deterministic where out-waiting it would not
        // be.
        //
        // A timeout rather than `requestAnimationFrame`, which does not run at
        // all while the page is hidden. That is not a hypothetical: a window
        // put in the background, or an Android app switched away from, would
        // never place the cursor and would then be told the item was gone.
        const soon = setTimeout(() => {
            if (attempt()) finish();
        });

        function finish() {
            clearTimeout(soon);
            clearTimeout(timer);
            if (!ed.isDestroyed) ed.off('update', onUpdate);
            cancelFocus = null;
        }

        // The collaboration binding fills the document in after the editor is
        // constructed, so on a cold open there is nothing to find yet.
        ed.on('update', onUpdate);
        cancelFocus = finish;
    }

    // Opening the same note at a different item does not rebuild the editor,
    // so the jump cannot live in `initializeEditor` alone.
    $effect(() => {
        const ordinal = focusTodo;
        const ed = editor;
        const docId = currentDocId;
        if (ed === null || docId === null || ordinal === null) return;

        const key = `${docId}:${ordinal}`;
        if (focusedKey === key) return;
        focusedKey = key;
        focusTaskItem(ed, ordinal);
    });

    // Reading and editing are one editor, switched, so the scroll position
    // and a peer's edits arriving carry on across the switch. Rebuilding the
    // editor for each mode would reload the document and lose the reader's
    // place.
    $effect(() => {
        const ed = editor;
        const on = editable;
        if (ed === null || ed.isDestroyed || ed.isEditable === on) return;
        // The editor on screen is for a document being replaced, and the
        // mode is the new document's. Its editor is built in that mode, and
        // this one is about to go.
        if (document?.id !== currentDocId) return;

        if (!on) {
            // A slash menu or picker left open would still insert when chosen,
            // into a document that is meant to be read-only by then.
            exitSuggestion(ed.view);
            closeAnyPicker();
        }
        ed.setEditable(on);
        if (on) placeCaretIfOnScreen(ed);
        // Out of the document, so a phone puts its keyboard away.
        else ed.commands.blur();
    });

    // Switched to editing: the caret goes where the selection is, which is
    // wherever the reader last clicked, or the item a todo jump landed on.
    // Only if that is on screen, though. Scrolling to it would lose the
    // reader's place, and so would typing at a caret out of sight, so then
    // the caret waits for a click where the writing is to go.
    function placeCaretIfOnScreen(ed: EditorType) {
        if (!element) return;
        let caret: { top: number; bottom: number };
        try {
            caret = ed.view.coordsAtPos(ed.state.selection.head);
        } catch {
            return; // not laid out yet
        }
        const box = (scroller ?? element).getBoundingClientRect();
        if (caret.top < box.top || caret.bottom > box.bottom) return;
        ed.commands.focus(null, { scrollIntoView: false });
    }

    function handleImageClick(e: MouseEvent) {
        // Selecting an image is how it gets its resize handles.
        if (!editor || !editor.isEditable) return;

        const target = e.target as HTMLElement;
        if (target.tagName !== 'IMG') return;
        e.preventDefault();
        e.stopPropagation();

        const pos = editor.view.posAtDOM(target, 0);
        if (typeof pos === 'number') {
            const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos));
            editor.view.dispatch(tr);
        }
    }

    // A phone's keyboard coming up makes the viewport shorter: on Android the
    // WebView is ended where the keyboard begins (see MainActivity). The caret
    // can then be below the new bottom edge, out of sight until something is
    // typed, so it is brought back into view. Any other resize while writing
    // keeps it in view the same way.
    function keepCaretInView() {
        if (editor?.isFocused) editor.commands.scrollIntoView();
    }

    $effect(() => {
        const el = element;
        const doc = document;

        if (el && !isInitialized && doc && !isLoadingEditor) {
            isLoadingEditor = true;
            initializeEditor().finally(() => {
                isLoadingEditor = false;
            });
        }
    });

    $effect(() => {
        const doc = document;

        if (doc && editor && ydoc && isInitialized && doc.id !== currentDocId) {
            isLoadingEditor = true;
            initializeEditor().finally(() => {
                isLoadingEditor = false;
            });
        }
    });

    onDestroy(() => {
        cancelFocus?.();

        if (ydoc && currentDocId) {
            onBeforeTeardown?.(currentDocId, ydoc);
            unregisterOpenDoc(currentDocId, ydoc);
        }

        if (editor) {
            editor.view.dom.removeEventListener('click', handleImageClick);
            // The document-link and tag pickers are mounted on the page, not
            // in the editor, so destroying the editor left one open. On the
            // next page it still took every key typed there, into an editor
            // that no longer existed. Leaving by the mouse closed it, since a
            // click elsewhere does; leaving by the keyboard or the back button
            // did not. The slash menu closes itself with the editor.
            closeAnyPicker();
            editor.destroy();
        }

        ydoc = null;
    });
</script>

<svelte:window onresize={keepCaretInView} />

<div class="editor-instance">
    {#if isLoadingEditor}
        <div class="loading-editor">
            <p>Loading editor...</p>
        </div>
    {/if}
    <div class="editor-content" class:read-only={!editable} bind:this={scroller}>
        {@render head?.()}
        <div bind:this={element}></div>
    </div>
</div>

<style>
    .editor-instance {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .loading-editor {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        color: var(--text-secondary);
    }

    .editor-content {
        flex: 1;
        padding: 28px 40px 140px;
        overflow-y: auto;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    /* A width made for reading: lines of about seventy characters, centred
       on the sheet however wide the window is. */
    .editor-content :global(.tiptap) {
        outline: none;
        min-height: 100%;
        max-width: 680px;
        margin: 0 auto;
        color: var(--text-primary);
        font-size: 15.5px;
        line-height: 1.68;
    }

    @media (max-width: 768px) {
        .editor-content {
            padding: 18px 20px 120px;
        }

        .editor-content :global(.tiptap) {
            font-size: 16px;
        }
    }

    .editor-content :global(.tiptap p.is-editor-empty:first-child::before) {
        content: attr(data-placeholder);
        float: left;
        color: var(--text-muted);
        pointer-events: none;
        height: 0;
    }

    .editor-content :global(h1) {
        font-size: 1.75em;
        line-height: 1.25;
        font-weight: 650;
        letter-spacing: -0.024em;
        margin: 1.1em 0 0.4em;
        color: var(--text-primary);
    }
    .editor-content :global(h2) {
        font-size: 1.25em;
        line-height: 1.4;
        font-weight: 620;
        letter-spacing: -0.014em;
        margin: 1.4em 0 0.25em;
        color: var(--text-primary);
    }
    .editor-content :global(h3) {
        font-size: 1.05em;
        font-weight: 620;
        margin: 1.2em 0 0.2em;
        color: var(--text-primary);
    }
    .editor-content :global(.tiptap > :first-child) {
        margin-top: 0;
    }
    .editor-content :global(p) {
        margin: 0.6em 0;
    }
    .editor-content :global(ul),
    .editor-content :global(ol) {
        margin: 0.3em 0 !important;
        padding-left: 2em;
        line-height: 1.7 !important;
    }
    .editor-content :global(ul li),
    .editor-content :global(ol li) {
        line-height: 1.7 !important;
        margin: 0 !important;
    }
    .editor-content :global(ul li p),
    .editor-content :global(ol li p) {
        margin: 0 !important;
        line-height: 1.7 !important;
    }
    .editor-content :global(code) {
        background: var(--code-bg);
        color: var(--text-primary);
        font-family: var(--font-mono);
        font-size: 0.88em;
        padding: 2px 5px;
        border-radius: var(--radius-sm);
    }
    .editor-content :global(pre) {
        background: var(--code-bg);
        color: var(--text-primary);
        padding: 16px;
        border-radius: var(--radius-lg);
        box-shadow: inset 0 0 0 1px var(--border-color);
        overflow-x: auto;
    }
    .editor-content :global(pre code) {
        padding: 0;
        background: none;
    }
    /* A code block's language, in its corner, so what it holds is on screen. */
    .editor-content :global(pre[data-language]) {
        position: relative;
    }
    .editor-content :global(pre[data-language]::before) {
        content: attr(data-language);
        position: absolute;
        top: 3px;
        right: 10px;
        font-family: inherit;
        font-size: 11px;
        line-height: 1;
        color: var(--text-secondary);
        pointer-events: none;
        user-select: none;
    }
    /* A Mermaid diagram while reading: its code is hidden, and the diagram
       drawn just before it stands in its place (ADR 0038). */
    .editor-content :global(pre.mermaid-source) {
        display: none;
    }
    .editor-content :global(.mermaid-diagram) {
        margin: 1em 0;
        overflow-x: auto;
        text-align: center;
    }
    .editor-content :global(.mermaid-diagram svg) {
        max-width: 100%;
        height: auto;
    }
    .editor-content :global(.mermaid-diagram.pending) {
        background: var(--code-bg);
        border-radius: 6px;
    }
    .editor-content :global(.mermaid-diagram.failed) {
        text-align: left;
    }
    .editor-content :global(.mermaid-error) {
        margin: 0 0 0.5em;
        color: var(--text-secondary);
        font-size: 0.9em;
    }
    .editor-content :global(blockquote) {
        border-left: 3px solid var(--border-light);
        margin: 1em 0;
        padding-left: 1em;
        color: var(--text-secondary);
    }
    .editor-content :global(a) {
        color: var(--accent-color);
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
    }

    .editor-content :global(.document-link) {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background-color: var(--accent-bg);
        color: var(--accent-color);
        padding: 1px 8px 1px 6px;
        border-radius: 7px;
        font-size: 0.94em;
        font-weight: 550;
        cursor: pointer;
        text-decoration: none;
        transition: background-color 0.2s;
    }

    .editor-content :global(.document-link:hover) {
        background-color: var(--accent-bg-hover);
    }

    /* The target is gone. Still readable, because the text is part of the
       sentence, but plainly not somewhere you can go. */
    .editor-content :global(.document-link-missing) {
        background-color: var(--bg-hover);
        color: var(--text-muted);
        text-decoration: line-through;
    }

    .editor-content :global(.document-link-missing:hover) {
        background-color: var(--bg-hover);
    }

    .editor-content :global(.document-link-icon) {
        font-size: 12px;
        color: var(--text-muted);
    }
    .editor-content :global(.document-link-title) {
        font-weight: 500;
    }

    /* A tag reads as one object in the middle of a sentence: rounded, quiet,
       and clearly not the words around it. Not the accent colour, which is
       already what a document link uses, so the two are told apart at a
       glance. */
    .editor-content :global(.tag-chip) {
        display: inline;
        background-color: var(--code-bg);
        color: var(--text-secondary);
        padding: 1px 8px 1px 7px;
        border-radius: 999px;
        box-shadow: inset 0 0 0 1px var(--border-color);
        font-size: 12.5px;
        font-weight: 500;
        white-space: nowrap;
    }

    /* The # in the tag's own hue, from its name (tagHue.ts). */
    .editor-content :global(.tag-hash) {
        color: var(--tag-hue, var(--tag-1));
        font-weight: 650;
        margin-right: 1px;
    }

    .editor-content :global(.tag-chip.ProseMirror-selectednode) {
        outline: 2px solid var(--accent-color);
        outline-offset: 1px;
    }

    .editor-content :global(ul[data-type='taskList']) {
        list-style: none;
        padding-left: 0;
        margin: 0;
    }

    .editor-content :global(ul[data-type='taskList'] > li) {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 2px 0;
    }

    .editor-content :global(ul[data-type='taskList'] > li > label) {
        display: flex;
        align-items: flex-start;
        gap: 2px;
        flex-shrink: 0;
    }

    /* No minimum width, so a task keeps to the width of the note as a
       paragraph does: a long link breaks onto the next line, and a wide
       table scrolls sideways by itself. A flex item is otherwise never
       narrower than its longest word or its table, so the task widened the
       note instead, and the whole note scrolled sideways. */
    .editor-content :global(ul[data-type='taskList'] > li > div) {
        flex: 1;
        min-width: 0;
    }

    .editor-content :global(ul[data-type='taskList'] > li > div > p) {
        margin: 0;
        display: inline;
        line-height: 1.68;
    }

    /* Drawn rather than left to the platform, so a tick box is the same on
       every system and scheme: a rounded square in the line controls are
       drawn with, filled with the accent once ticked. */
    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']) {
        appearance: none;
        -webkit-appearance: none;
        margin: 4px 0 0;
        width: 18px;
        height: 18px;
        border-radius: 5px;
        background: var(--bg-raised);
        box-shadow: inset 0 0 0 1.5px var(--control-line);
        display: grid;
        place-items: center;
        cursor: pointer;
        transition:
            background-color 0.12s,
            box-shadow 0.12s;
    }

    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']::after) {
        content: '';
        width: 5px;
        height: 9px;
        margin-top: -2px;
        border: solid var(--on-accent);
        border-width: 0 2px 2px 0;
        transform: rotate(45deg) scale(0);
        transition: transform 0.12s;
    }

    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']:checked) {
        background: var(--btn-primary-bg);
        box-shadow: none;
    }

    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']:checked::after) {
        transform: rotate(45deg) scale(1);
    }

    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']:focus-visible) {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }

    /* Done reads as done: struck through, in the muted colour. */
    .editor-content :global(ul[data-type='taskList'] > li[data-checked='true'] > div) {
        color: var(--text-muted);
        text-decoration: line-through;
        text-decoration-color: var(--control-line);
    }

    @media (pointer: coarse) {
        .editor-content :global(ul[data-type='taskList'] input[type='checkbox']) {
            width: 22px;
            height: 22px;
            border-radius: 7px;
            margin-top: 2px;
        }
    }

    /* A table wider than the note scrolls sideways by itself, and the rest
       of the note stays put. On a phone, a table of long words is easily
       wider than the screen, and it used to widen the note instead, so the
       whole note scrolled sideways with it and the start of every line went
       off the left edge. The editor puts every table in a .tableWrapper
       (TipTap's TableView). The margin is on the wrapper: a box that scrolls
       keeps its content's margins inside it, so on the table they would add
       to the margins of the paragraphs around it rather than collapse with
       them. */
    .editor-content :global(.tableWrapper) {
        margin: 1em 0;
        overflow-x: auto;
    }

    .editor-content :global(table) {
        border-collapse: collapse;
        width: 100%;
    }

    .editor-content :global(th),
    .editor-content :global(td) {
        border: 1px solid var(--border-light);
        padding: 8px;
        text-align: left;
        color: var(--text-primary);
    }

    .editor-content :global(th) {
        background: var(--bg-secondary);
    }

    /* No space above or below a cell's text. The space that sets one
       paragraph apart from the next is only empty room in a table, and it
       made a row of one line 76px tall where its text and padding take 44px.
       Two paragraphs in one cell, from Enter while typing in it, read as two
       lines, as in a list. */
    .editor-content :global(:is(th, td) > p) {
        margin: 0;
    }

    /* An attachment whose bytes have not arrived from the other device yet.
       The placeholder is a transparent 1x1 pixel, which on its own is
       indistinguishable from nothing being there at all. */
    .editor-content :global(img.attachment-pending) {
        min-width: 120px;
        min-height: 90px;
        background: var(--bg-hover);
        border: 1px dashed var(--border-color);
        border-radius: 6px;
    }

    .editor-content :global(img) {
        max-width: 100%;
        height: auto;
        border-radius: 4px;
        display: block;
        margin: 1em 0;
        cursor: pointer;
    }

    .editor-content :global(.ProseMirror-selectednode img) {
        outline: 2px solid var(--accent-color);
    }

    .editor-content :global(.ProseMirror-proseMirror img.ProseMirror-selectednode) {
        cursor: nwse-resize;
    }

    .editor-content :global(.resize-handle),
    .editor-content :global([data-resize-handle]) {
        opacity: 0;
        width: 12px !important;
        height: 12px !important;
        background: var(--accent-color) !important;
        border: 2px solid var(--bg-primary) !important;
        border-radius: 3px !important;
        position: absolute !important;
        z-index: 10 !important;
        cursor: nwse-resize !important;
        pointer-events: none !important;
    }

    .editor-content :global(.ProseMirror-selectednode .resize-handle),
    .editor-content :global(.ProseMirror-selectednode [data-resize-handle]) {
        opacity: 1 !important;
        pointer-events: all !important;
    }

    /* Reading: nothing in the document offers to be changed but its tick
       boxes, which still tick. Images and tags do not show that they are
       selected, and images lose their resize handles; the editor removes
       those itself, and this covers an image drawn before it has. */
    .editor-content.read-only :global(img) {
        cursor: default;
    }

    .editor-content.read-only :global(.ProseMirror-selectednode img),
    .editor-content.read-only :global(.tag-chip.ProseMirror-selectednode) {
        outline: none;
    }

    .editor-content.read-only :global(.resize-handle),
    .editor-content.read-only :global([data-resize-handle]) {
        display: none !important;
    }

    /* The item a jump from the todo index landed on, lit for a moment. The
       length is JUMP_TARGET_MS in jumpTarget.ts. */
    .editor-content :global(.jump-target) {
        border-radius: 4px;
        animation: jump-target 2s ease-out;
    }

    @keyframes jump-target {
        0%,
        40% {
            background-color: var(--accent-bg);
        }
        100% {
            background-color: transparent;
        }
    }

    .editor-content :global(.collaboration-cursor__caret) {
        border-left: 1px solid var(--accent-color);
        border-right: 1px solid var(--accent-color);
        margin-left: -1px;
        margin-right: -1px;
        pointer-events: none;
        position: relative;
        word-break: normal;
    }

    .editor-content :global(.collaboration-cursor__label) {
        border-radius: 3px 3px 3px 0;
        color: white;
        font-size: 11px;
        font-weight: 600;
        left: -1px;
        line-height: normal;
        padding: 2px 5px;
        position: absolute;
        top: -1.4em;
        user-select: none;
        white-space: nowrap;
        pointer-events: none;
    }
</style>
