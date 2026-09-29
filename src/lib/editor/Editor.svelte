<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { currentDocument } from '$lib/stores/app';
    import { indexRevision as derivedRevision } from '$lib/stores/derivedIndex';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Toolbar } from '$lib/editor';
    import EditorInstance from './EditorInstance.svelte';
    import Backlinks from './Backlinks.svelte';
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
    }

    let { debounceMs = DEFAULT_DEBOUNCE_MS, focusTodo = null, editable = true }: Props = $props();

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

<div class="editor-container">
    {#if current}
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
