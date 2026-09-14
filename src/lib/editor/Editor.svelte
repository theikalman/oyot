<script lang="ts">
    import { log } from '$lib/log';
    import { onMount, onDestroy } from 'svelte';
    import { listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { currentDocument, appStore } from '$lib/stores/app';
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
    import { loadDocument } from '$lib/services/documents';
    import { extractDocumentIndex } from './documentIndex';
    import * as Y from 'yjs';

    interface Props {
        debounceMs?: number;
    }

    let { debounceMs = DEFAULT_DEBOUNCE_MS }: Props = $props();

    let current = $derived($currentDocument);
    let editorInstance = $state<EditorType | null>(null);
    let saveService = $state<EditorSaveService | null>(null);
    let unlistenSyncEvent: (() => void) | null = null;
    // Bumped after a save so the backlinks panel re-reads: a link added in this
    // document changes what other documents' panels show, and this one's too if
    // the save also removed a link.
    let indexRevision = $state(0);
    let unlistenCloseRequested: (() => void) | null = null;

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

    function handleLocalUpdate(update: Uint8Array) {
        saveService?.recordUpdate(update);
    }

    // EditorInstance is about to destroy the editor behind `doc`. Encode now,
    // synchronously, and let the write land in the background: once the editor
    // is gone the ydoc can no longer be read.
    //
    // `saveService` still points at the outgoing document at this point (the
    // incoming one is set later, in handleEditorReady), so its pending flag
    // answers for the document being torn down. Skipping when nothing is
    // pending keeps plain navigation from rewriting and re-broadcasting a
    // document nobody edited.
    function handleBeforeTeardown(docId: string, doc: Y.Doc) {
        if (!saveService?.hasPendingWrite()) return;
        const delta = saveService.takePendingDelta();
        const snapshot = Y.encodeStateAsUpdate(doc);
        // Read the index here, while the editor still exists.
        const index = editorInstance ? extractDocumentIndex(editorInstance.state.doc) : undefined;
        // Nothing awaits this; persistSnapshot rethrows after reporting, so
        // swallow here rather than leave an unhandled rejection on a teardown.
        void persistSnapshot(docId, snapshot, delta, index).catch(() => {});
    }

    async function handleOpenDocument(event: Event) {
        const { id } = (event as CustomEvent<{ id: string }>).detail;
        if (!id) return;
        try {
            const doc = await loadDocument(id);
            appStore.setCurrentDocument(doc);
        } catch {
            // loadDocument already shows a toast on error
        }
    }

    // The debounce timer dies with the process, so flush on every predictable
    // exit. `hidden` is the one that matters on mobile: Android can kill a
    // backgrounded app without ever firing a close event.
    function handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            void saveService?.flushNow();
        }
    }

    onMount(async () => {
        window.addEventListener('openDocument', handleOpenDocument);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('pagehide', handleVisibilityChange);

        try {
            unlistenCloseRequested = await getCurrentWindow().onCloseRequested(() => {
                void saveService?.flushNow();
            });
        } catch (e) {
            // Not running under Tauri (unit tests, browser preview): the
            // visibilitychange and pagehide listeners above still cover it.
            console.warn('[Editor] window close listener unavailable:', e);
        }

        // A peer's edit is applied straight into the open document by the
        // sync layer, so there is nothing to fetch here and nothing to apply.
        // What still needs telling is the panel below the editor, which reads
        // derived rows out of SQL rather than out of the document.
        unlistenSyncEvent = await listen('sync-received', (event) => {
            const payload = event.payload as { doc_id?: string };
            log.debug(`[Editor] event: sync-received doc_id=${payload?.doc_id ?? '(none)'}`);
            if (payload?.doc_id && payload.doc_id === current?.id) {
                indexRevision++;
            }
        });
    });

    onDestroy(() => {
        window.removeEventListener('openDocument', handleOpenDocument);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('pagehide', handleVisibilityChange);
        unlistenSyncEvent?.();
        unlistenCloseRequested?.();
        if (saveService) {
            saveService.destroy();
        }
    });
</script>

<div class="editor-container">
    {#if current}
        <Toolbar editor={editorInstance} />

        <EditorInstance
            document={current}
            onEditorReady={handleEditorReady}
            onBeforeTeardown={handleBeforeTeardown}
            onLocalUpdate={handleLocalUpdate}
        />

        <Backlinks docId={current.id} revision={indexRevision} />
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
