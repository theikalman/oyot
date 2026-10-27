<script lang="ts">
    import { onMount, onDestroy, type Snippet } from 'svelte';
    import { currentDocument } from '$lib/stores/app';
    import { indexRevision as derivedRevision } from '$lib/stores/derivedIndex';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Toolbar } from '$lib/editor';
    import EditorInstance from './EditorInstance.svelte';
    import Backlinks from './Backlinks.svelte';
    import FindBar from './FindBar.svelte';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import {
        createSaveService,
        persistSnapshot,
        DEFAULT_DEBOUNCE_MS,
        type EditorSaveService,
    } from './EditorSaveService';
    import { extractDocumentIndex } from './documentIndex';
    import { registerPendingSave } from './pendingSaves';
    import * as Y from 'yjs';

    interface Props {
        debounceMs?: number;
        // Which task item to put the cursor on, from the URL. Passed through
        // rather than read here: the route owns what the URL means.
        focusTodo?: number | null;
        // False to show the document for reading, without the toolbar.
        editable?: boolean;
        /** Drawn above the document, scrolling with it. */
        head?: Snippet;
    }

    let {
        debounceMs = DEFAULT_DEBOUNCE_MS,
        focusTodo = null,
        editable = true,
        head,
    }: Props = $props();

    let current = $derived($currentDocument);
    let editorInstance = $state<EditorType | null>(null);
    let saveService = $state<EditorSaveService | null>(null);
    // Bumped after a save so the backlinks panel re-reads: a link added in this
    // document changes what other documents' panels show, and this one's too if
    // the save also removed a link. The panel also re-reads whenever derived
    // rows change anywhere, a peer's edit to another note among them.
    let indexRevision = $state(0);

    // Closing the window saves through the layout, which flushes every
    // editor registered here (ADR 0030, decision 5). The editor used to listen
    // for the close itself, and that listener is what made Tauri destroy the
    // window once it returned, even when Rust only meant to hide it.
    const unregisterPendingSave = registerPendingSave(() =>
        saveService?.hasPendingWrite() ? saveService.flushNow() : null,
    );

    function handleEditorReady(editor: EditorType, doc: Y.Doc) {
        editorInstance = editor;

        if (saveService) {
            saveService.destroy();
        }

        saveService = createSaveService({
            debounceMs,
            onSaved: () => {
                indexRevision++;
            },
        });

        // Only the editor can read the rendered document, so it supplies the
        // index the save path records: text for search, link targets, todo
        // counts. Read lazily at flush time so it reflects the final state.
        saveService.setIndexReader(() =>
            editorInstance ? extractDocumentIndex(editorInstance.state.doc) : null,
        );

        if (current) {
            saveService.setDocument(current);
            saveService.setYDoc(doc);
        }
    }

    // The find box, while reading and while editing. Kept open across a
    // switch to another document, which it then looks in, as a browser's
    // does across pages.
    let finding = $state(false);
    let findRequest = $state({ text: '' });

    // Taken wherever focus is on the page, as Edit is, and kept from the web
    // view, which has a find bar of its own on some platforms that knows
    // nothing of the editor. Not over a dialog. Pressed again with the box
    // open, it goes back to the box with what is in it selected.
    function handleKeydown(event: KeyboardEvent) {
        if (!current || !customShortcuts.matches('find', event)) return;
        event.preventDefault();
        if (document.querySelector('[aria-modal="true"]')) return;
        // What is selected in the document, as a browser starts with, when
        // it is a few words on one line.
        const selected = editorInstance
            ? editorInstance.state.doc.textBetween(
                  editorInstance.state.selection.from,
                  editorInstance.state.selection.to,
                  '\n',
              )
            : '';
        const text = selected.length <= 200 && !selected.includes('\n') ? selected : '';
        finding = true;
        findRequest = { text };
    }

    function handleLocalUpdate() {
        saveService?.recordUpdate();
    }

    // EditorInstance is about to destroy the editor behind `doc`. Encode now,
    // synchronously, and let the write land in the background: once the editor
    // is gone the ydoc can no longer be read.
    //
    // `saveService` still points at the outgoing document at this point (the
    // incoming one is set later, in handleEditorReady), so its pending flag
    // answers for the document being torn down. Skipping when nothing is
    // pending keeps plain navigation from rewriting a document nobody edited.
    function handleBeforeTeardown(docId: string, doc: Y.Doc) {
        if (!saveService?.hasPendingWrite()) return;
        const snapshot = Y.encodeStateAsUpdate(doc);
        // Read the index here, while the editor still exists.
        const index = editorInstance ? extractDocumentIndex(editorInstance.state.doc) : undefined;
        // Nothing awaits this; persistSnapshot rethrows after reporting, so
        // swallow here rather than leave an unhandled rejection on a teardown.
        void persistSnapshot(docId, snapshot, index).catch(() => {});
    }

    // The debounce timer dies with the process, so flush on every predictable
    // exit. `hidden` is the one that matters on mobile: Android can kill a
    // backgrounded app without ever firing a close event.
    function handleVisibilityChange() {
        // Only when there is something to write. Flushing regardless rewrote
        // the whole document each time the user switched away from the window.
        if (document.visibilityState === 'hidden' && saveService?.hasPendingWrite()) {
            void saveService.flushNow();
        }
    }

    onMount(() => {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pagehide', handleVisibilityChange);
    });

    onDestroy(() => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('pagehide', handleVisibilityChange);
        unregisterPendingSave();
        if (saveService) {
            saveService.destroy();
        }
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="editor-container">
    {#if current}
        {#if finding}
            <FindBar
                request={findRequest}
                editor={editorInstance}
                onClose={() => (finding = false)}
            />
        {/if}

        {#if editable}
            <Toolbar editor={editorInstance} />
        {/if}

        <EditorInstance
            document={current}
            onEditorReady={handleEditorReady}
            onBeforeTeardown={handleBeforeTeardown}
            onLocalUpdate={handleLocalUpdate}
            {focusTodo}
            {editable}
            {head}
        />

        <Backlinks docId={current.id} revision={indexRevision + $derivedRevision} />
    {:else}
        <div class="empty-state">
            <p>Select a file to edit</p>
        </div>
    {/if}
</div>

<style>
    .editor-container {
        position: relative;
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
    }
</style>
