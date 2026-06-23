<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import { listen } from '@tauri-apps/api/event';
    import { currentDocument, appStore } from '$lib/stores/app';
    import type { Editor as EditorType } from '@tiptap/core';
    import type { Document } from '$lib/types';
    import { Toolbar, EditorHeader } from '$lib/editor';
    import EditorInstance from './EditorInstance.svelte';
    import { createSaveService, type EditorSaveService } from './EditorSaveService';
    import { loadDocument } from '$lib/services/documents';
    import * as Y from 'yjs';

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
            debounceMs,
            onSaving: () => { isSaving = true; },
            onSaved: () => { isSaving = false; }
        });

        if (current) {
            saveService.setDocument(current);
            saveService.setYDoc(doc);
        }
    }

    function handleContentChange() {
        saveService?.triggerSave();
    }

    async function handleDocumentChange(newDoc: Document | null, oldDoc: Document | null) {
        if (!newDoc || !oldDoc) return;

        if (saveService && previousDocId && previousDocId !== newDoc.id) {
            await saveService.forceSave();
        }

        previousDocId = newDoc.id;
        saveService?.setDocument(newDoc);
    }

    async function reloadCurrentDocument() {
        if (!current?.id) return;
        try {
            const stateResult = await invoke<{ doc_id: string; state: number[] }>('get_yjs_state', {
                docId: current.id,
            });
            if (stateResult.state && stateResult.state.length > 0 && ydoc) {
                Y.applyUpdate(ydoc, new Uint8Array(stateResult.state));
            }
        } catch (error) {
            console.error('[Editor] Failed to reload document:', error);
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

    onMount(async () => {
        window.addEventListener('openDocument', handleOpenDocument);
        unlistenSyncEvent = await listen('sync-received', async (event) => {
            const payload = event.payload as { doc_id?: string };
            if (payload?.doc_id && payload.doc_id === current?.id) {
                await reloadCurrentDocument();
            }
        });
    });

    onDestroy(() => {
        window.removeEventListener('openDocument', handleOpenDocument);
        unlistenSyncEvent?.();
        if (saveService) {
            saveService.destroy();
        }
    });

    $effect(() => {
        const newDoc = current;
        if (newDoc) {
            handleDocumentChange(newDoc, previousDocId ? { id: previousDocId } as Document : null);
        }
    });
</script>

<div class="editor-container">
    {#if current}
        <Toolbar editor={editorInstance} />
        
        <EditorInstance
            document={current}
            {autoSave}
            {debounceMs}
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