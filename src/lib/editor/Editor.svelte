<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { listen } from '@tauri-apps/api/event';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { currentDocument, appStore } from '$lib/stores/app';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Toolbar } from '$lib/editor';
    import EditorInstance from './EditorInstance.svelte';
    import {
        createSaveService,
        persistSnapshot,
        DEFAULT_DEBOUNCE_MS,
        type EditorSaveService,
    } from './EditorSaveService';
    import { loadDocument } from '$lib/services/documents';
    import * as Y from 'yjs';

    interface Props {
        debounceMs?: number;
        autoSave?: boolean;
    }

    let { debounceMs = DEFAULT_DEBOUNCE_MS, autoSave = true }: Props = $props();

    let current = $derived($currentDocument);
    let ydoc = $state<Y.Doc | null>(null);
    let editorInstance = $state<EditorType | null>(null);
    let saveService = $state<EditorSaveService | null>(null);
    let unlistenSyncEvent: (() => void) | null = null;
    let unlistenCloseRequested: (() => void) | null = null;

    function handleEditorReady(editor: EditorType, doc: Y.Doc) {
        editorInstance = editor;
        ydoc = doc;

        if (saveService) {
            saveService.destroy();
        }

        saveService = createSaveService({ debounceMs });

        if (current) {
            saveService.setDocument(current);
            saveService.setYDoc(doc);
        }
    }

    function handleContentChange() {
        saveService?.triggerSave();
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
        void persistSnapshot(docId, Y.encodeStateAsUpdate(doc));
    }

    async function reloadCurrentDocument() {
        if (!current?.id) return;
        console.log(`[Editor] reloadCurrentDocument() for docId=${current.id}`);
        try {
            const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', {
                docId: current.id,
            });
            console.log(
                `[Editor] [${current.id}] Fetched state: ${stateResult.state?.length ?? 0} bytes, ydoc present=${!!ydoc}`,
            );
            if (stateResult.state && stateResult.state.length > 0 && ydoc) {
                Y.applyUpdate(ydoc, new Uint8Array(stateResult.state));
                console.log(`[Editor] [${current.id}] Applied fetched state to editor ydoc`);
            }
        } catch (error) {
            console.error(`[Editor] [${current.id}] Failed to reload document:`, error);
        }
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

        unlistenSyncEvent = await listen('sync-received', async (event) => {
            const payload = event.payload as { doc_id?: string; from?: string };
            console.log(
                `[Editor] event: sync-received doc_id=${payload?.doc_id ?? '(none)'} from=${payload?.from ?? '(local)'} currentDocId=${current?.id ?? '(none)'}`,
            );
            if (payload?.doc_id && payload.doc_id === current?.id) {
                await reloadCurrentDocument();
            } else {
                console.log(
                    `[Editor] Ignoring sync-received, doc_id does not match currently open document`,
                );
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
            {autoSave}
            onEditorReady={handleEditorReady}
            onContentChange={handleContentChange}
            onBeforeTeardown={handleBeforeTeardown}
        />
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
