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

    interface Props {
        debounceMs?: number;
        autoSave?: boolean;
    }

    let {
        debounceMs = 1000,
        autoSave = true
    }: Props = $props();

    let current = $derived($currentDocument);
    let loroDoc = $state<any>(null);
    let editorInstance = $state<EditorType | null>(null);
    let saveService = $state<EditorSaveService | null>(null);
    let isSaving = $state(false);
    let unlistenSyncEvent: (() => void) | null = null;
    let previousDocId = $state<string | null>(null);

    function handleEditorReady(editor: EditorType, doc: any) {
        editorInstance = editor;
        loroDoc = doc;

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
            saveService.setLoroDoc(doc);
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
            const doc: Document = await invoke('get_document', { docId: current.id });
            appStore.setCurrentDocument(doc);
        } catch (error) {
            console.error('[Editor] Failed to reload document:', error);
        }
    }

    onMount(async () => {
        unlistenSyncEvent = await listen('sync-received', async (event) => {
            console.log('[Editor] Received sync event:', event);
            const docId = (event.payload as { docId?: string })?.docId;
            if (docId && docId === current?.id) {
                await reloadCurrentDocument();
            }
        });
    });

    onDestroy(() => {
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
