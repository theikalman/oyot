<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import type * as Y from 'yjs';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Editor } from '@tiptap/core';
    import { NodeSelection } from 'prosemirror-state';
    import { Plugin } from '@tiptap/pm/state';
    import Placeholder from '@tiptap/extension-placeholder';
    import { Extension } from '@tiptap/core';
    import { exitSuggestion } from '@tiptap/suggestion';
    import { SlashCommand } from '$lib/tiptap/SlashCommand';
    import { closeAnyPicker } from '$lib/tiptap/pickerPopup';
    import { createContentExtensions } from './extensions';
    import {
        registerDocumentLinkCommand,
        registerDateCommand,
        registerTodoCommand,
        registerTagCommand,
        registerImageCommand,
    } from '$lib/tiptap';
    import { createCollaborationExtension } from './yjs';
    import { CONTENT_FIELD } from './contentField';
    import { REMOTE_ORIGIN } from './origin';
    import { unregisterOpenDoc } from './openDocs';
    import { locateTaskItem } from './taskItems';
    import { JumpTarget, markJumpTarget } from './jumpTarget';
    import { toasts } from '$lib/services/toast';
    import { documentRepository } from '$lib/sync';

    const ScrollOnFocus = Extension.create({
        name: 'scrollOnFocus',
        onSelectionUpdate() {
            const vp = window.visualViewport;
            if (vp && vp.height < initialViewportHeight - 100) {
                requestAnimationFrame(() => {
                    this.editor.commands.scrollIntoView();
                });
            }
        },
    });

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
        // from a peer are tagged REMOTE_ORIGIN and skipped, so a merge is not
        // rebroadcast to the peer that sent it.
        onLocalUpdate?: (update: Uint8Array) => void;
        // Which of the document's task items to put the cursor on, counted
        // depth-first, as the todo index addresses one. Null for an ordinary
        // open, which leaves the cursor wherever the editor puts it.
        focusTodo?: number | null;
        // False to show the document for reading: nothing typed, clicked or
        // pasted changes it. A peer's edit still lands, since that is the
        // document changing rather than the reader changing it.
        editable?: boolean;
    }

    let {
        document,
        onEditorReady,
        onBeforeTeardown,
        onLocalUpdate,
        focusTodo = null,
        editable = true,
    }: Props = $props();

    let element = $state<HTMLDivElement | null>(null);
    let editor = $state.raw<EditorType | null>(null);
    let ydoc = $state.raw<any>(null);
    let isInitialized = $state.raw(false);
    let currentDocId = $state.raw<string | null>(null);
    let isLoadingEditor = $state.raw(false);

    let initialViewportHeight = 0;
    let keyboardOpen = $state(false);
    let keyboardHeight = $state(0);

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
                ScrollOnFocus,
                ReadOnlyState,
                JumpTarget,
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

        // The only thing that schedules a save. Tiptap's `onUpdate` used to do
        // it as well, which meant a peer's edit landing in this document
        // scheduled a save whose "delta" was the whole document, sent straight
        // back to the peer that had just sent it.
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
        const box = element.getBoundingClientRect();
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

    function handleViewportChange() {
        const vp = window.visualViewport;
        if (!vp) return;
        keyboardOpen = vp.height < initialViewportHeight - 100;
        keyboardHeight = keyboardOpen ? initialViewportHeight - vp.height : 0;
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

    onMount(() => {
        initialViewportHeight = window.innerHeight;
        window.visualViewport?.addEventListener('resize', handleViewportChange);
        window.visualViewport?.addEventListener('scroll', handleViewportChange);
    });

    onDestroy(() => {
        cancelFocus?.();
        window.visualViewport?.removeEventListener('resize', handleViewportChange);
        window.visualViewport?.removeEventListener('scroll', handleViewportChange);

        if (ydoc && currentDocId) {
            onBeforeTeardown?.(currentDocId, ydoc);
            unregisterOpenDoc(currentDocId, ydoc);
        }

        if (editor) {
            editor.view.dom.removeEventListener('click', handleImageClick);
            editor.destroy();
        }

        ydoc = null;
    });
</script>

<div class="editor-instance" style="padding-bottom: {keyboardOpen ? keyboardHeight : 0}px;">
    {#if isLoadingEditor}
        <div class="loading-editor">
            <p>Loading editor...</p>
        </div>
    {/if}
    <div class="editor-content" class:read-only={!editable} bind:this={element}></div>
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
        padding: 24px;
        overflow-y: auto;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .editor-content :global(.tiptap) {
        outline: none;
        min-height: 100%;
        color: var(--text-primary);
        line-height: 1.7;
    }

    .editor-content :global(.tiptap p.is-editor-empty:first-child::before) {
        content: attr(data-placeholder);
        float: left;
        color: var(--text-muted);
        pointer-events: none;
        height: 0;
    }

    .editor-content :global(h1) {
        font-size: 2em;
        margin: 0.67em 0;
        color: var(--text-primary);
    }
    .editor-content :global(h2) {
        font-size: 1.5em;
        margin: 0.83em 0;
        color: var(--text-primary);
    }
    .editor-content :global(h3) {
        font-size: 1.17em;
        margin: 1em 0;
        color: var(--text-primary);
    }
    .editor-content :global(p) {
        margin: 1em 0;
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
        padding: 2px 4px;
        border-radius: 3px;
    }
    .editor-content :global(pre) {
        background: var(--code-bg);
        color: var(--text-primary);
        padding: 16px;
        border-radius: 6px;
        overflow-x: auto;
    }
    .editor-content :global(blockquote) {
        border-left: 4px solid var(--border-light);
        margin: 1em 0;
        padding-left: 1em;
        color: var(--text-secondary);
    }
    .editor-content :global(a) {
        color: var(--accent-color);
        text-decoration: underline;
    }

    .editor-content :global(.document-link) {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background-color: var(--accent-bg);
        color: var(--accent-color);
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 14px;
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
        background-color: var(--bg-hover);
        color: var(--text-secondary);
        padding: 1px 8px;
        border-radius: 10px;
        border: 1px solid var(--border-light);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
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
        gap: 4px;
        padding: 1px 0;
    }

    .editor-content :global(ul[data-type='taskList'] > li > label) {
        display: flex;
        align-items: flex-start;
        gap: 2px;
        flex-shrink: 0;
    }

    .editor-content :global(ul[data-type='taskList'] > li > div) {
        flex: 1;
    }

    .editor-content :global(ul[data-type='taskList'] > li > div > p) {
        margin: 0;
        display: inline;
        line-height: 1.4;
    }

    .editor-content :global(ul[data-type='taskList'] input[type='checkbox']) {
        margin-top: 4px;
        width: 18px;
        height: 18px;
        accent-color: var(--accent-color);
        cursor: pointer;
    }

    .editor-content :global(table) {
        border-collapse: collapse;
        margin: 1em 0;
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
        background: var(--accent-color, #6366f1) !important;
        border: 2px solid white !important;
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

    /* Reading: nothing in the document offers to be changed. A tick box that
       looks clickable and then refuses reads as broken, so it stops taking
       the pointer at all, label included, since clicking a label ticks its
       box. Images and tags do not show that they are selected, and images
       lose their resize handles; the editor removes those itself, and this
       covers an image drawn before it has. */
    .editor-content.read-only :global(ul[data-type='taskList'] > li > label) {
        pointer-events: none;
    }

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
        border-left: 1px solid #6366f1;
        border-right: 1px solid #6366f1;
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
