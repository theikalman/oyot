<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { listen } from '@tauri-apps/api/event';
    import * as Y from 'yjs';
    import { currentDocument, appStore } from '$lib/stores/app';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Toolbar } from '$lib/editor';
    import EditorInstance from './EditorInstance.svelte';
    import { createSaveService, REMOTE_ORIGIN, type EditorSaveService } from './EditorSaveService';

    interface Props {
        debounceMs?: number;
        autoSave?: boolean;
    }

    let {
        debounceMs = 1000,
        autoSave = true
    }: Props = $props();

    let current = $derived($currentDocument);
    let ydoc = $state<Y.Doc | null>(null);
    let editorInstance = $state<EditorType | null>(null);
    let saveService = $state<EditorSaveService | null>(null);
    let isSaving = $state(false);
    let unlistenSyncEvent: (() => void) | null = null;
    let previousDocId = $state<string | null>(null);

    function handleEditorReady(editor: EditorType, doc: Y.Doc) {
        editorInstance = editor;
        ydoc = doc;

        if (saveService) {
            saveService.destroy();
        }

        saveService = createSaveService({
            onSaving: () => { isSaving = true; },
            onSaved: () => { isSaving = false; }
        });

        if (current) {
            saveService.setDocument(current);
            saveService.setYjsDoc(doc);
        }
    }

    function handleContentChange() {
        // Content changes are handled by the ydoc 'update' listener in EditorSaveService.
        // This callback is kept for potential future use (e.g., UI dirty indicator).
    }

    $effect(() => {
        const newDoc = current;
        if (newDoc && newDoc.id !== previousDocId) {
            previousDocId = newDoc.id;
            saveService?.setDocument(newDoc);
        }
    });

    onMount(async () => {
        unlistenSyncEvent = await listen('remote_network_update', (event) => {
            const payload = event.payload as { doc_id?: string; update_blob?: number[] };
            const docId = payload?.doc_id;
            const rawBlob = payload?.update_blob;

            if (!docId || docId !== current?.id) return;
            if (!rawBlob || !ydoc) return;

            // Apply the remote update with a tagged origin so EditorSaveService
            // knows not to re-persist or re-broadcast it.
            const update = new Uint8Array(rawBlob);
            Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
        });
    });

    onDestroy(() => {
        unlistenSyncEvent?.();
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
            onContentChange={handleContentChange}
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
