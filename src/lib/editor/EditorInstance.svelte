<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import type { Editor as EditorType } from '@tiptap/core';
    import { Editor } from '@tiptap/core';
    import { NodeSelection } from 'prosemirror-state';
    import StarterKit from '@tiptap/starter-kit';
    import Placeholder from '@tiptap/extension-placeholder';
    import TaskList from '@tiptap/extension-task-list';
    import TaskItem from '@tiptap/extension-task-item';
    import { Table } from '@tiptap/extension-table';
    import TableRow from '@tiptap/extension-table-row';
    import TableCell from '@tiptap/extension-table-cell';
    import TableHeader from '@tiptap/extension-table-header';
    import Typography from '@tiptap/extension-typography';
    import { Extension } from '@tiptap/core';
    import { SlashCommand } from '$lib/tiptap/SlashCommand';
    import { DocumentLinkNode } from '$lib/tiptap/nodes/DocumentLinkNode';
    import {
        registerDocumentLinkCommand,
        registerDateCommand,
        registerTodoCommand,
        registerImageCommand,
    } from '$lib/tiptap';
    import { ResizableImage } from '$lib/tiptap/extensions/ResizableImage';
    import { ImageExtension } from '$lib/tiptap/extensions/ImageExtension';
    import {
        createLoroDoc,
        createPresenceStore,
        loadLoroDocFromState,
        createInitialContent,
        exportLoroDocSnapshot,
        addLoroPluginsToEditor,
    } from '$lib/loro/LoroEditorExtension';

    const ScrollOnFocus = Extension.create({
        name: 'scrollOnFocus',
        onSelectionUpdate() {
            const vp = window.visualViewport;
            if (vp && vp.height < initialViewportHeight - 100) {
                requestAnimationFrame(() => {
                    this.editor.commands.scrollIntoView();
                });
            }
        }
    });

    interface Props {
        document: any | null;
        autoSave?: boolean;
        debounceMs?: number;
        onEditorReady?: (editor: EditorType, loroDoc: any) => void;
        onContentChange?: () => void;
    }

    let {
        document,
        autoSave = true,
        debounceMs = 1000,
        onEditorReady,
        onContentChange
    }: Props = $props();

    let element = $state<HTMLDivElement | null>(null);
    let editor = $state.raw<EditorType | null>(null);
    let loroDoc = $state.raw<any>(null);
    let isInitialized = $state.raw(false);
    let currentDocId = $state.raw<string | null>(null);
    let isLoadingLoro = $state.raw(false);

    let initialViewportHeight = 0;
    let keyboardOpen = $state(false);
    let keyboardHeight = $state(0);

    async function initializeEditor() {
        if (!element) {
            return false;
        }

        if (editor) {
            editor.destroy();
            editor = null;
        }
        if (loroDoc) {
            loroDoc = null;
        }

        const newLoroDoc = await loadLoroDocFromState(
            document?.crdt_state ? new Uint8Array(document.crdt_state) : new Uint8Array()
        );

        const title = document?.title ?? 'Untitled';
        let initialContent: object = createInitialContent(title) as object;

        const ed = new Editor({
            element,
            extensions: [
                StarterKit,
                ResizableImage.configure({
                    inline: false,
                    allowBase64: true
                }),
                ImageExtension,
                Placeholder.configure({
                    placeholder: 'Start writing...'
                }),
                TaskList,
                TaskItem.configure({
                    nested: true
                }),
                Table.configure({
                    resizable: true
                }),
                TableRow,
                TableHeader,
                TableCell,
                Typography,
                DocumentLinkNode,
                SlashCommand,
                ScrollOnFocus,
            ],
            content: initialContent,
            editable: true,
            onUpdate: () => {
                if (autoSave && editor) {
                    onContentChange?.();
                }
            }
        });

        ed.view.dom.addEventListener('click', handleImageClick);

        registerDocumentLinkCommand(ed);
        registerDateCommand(ed);
        registerTodoCommand(ed);
        registerImageCommand(ed);

        const presenceStore = await createPresenceStore(newLoroDoc);
        await addLoroPluginsToEditor(ed, newLoroDoc, presenceStore);

        loroDoc = newLoroDoc;
        editor = ed;
        isInitialized = true;
        currentDocId = document?.id ?? null;

        onEditorReady?.(ed, newLoroDoc);
        return true;
    }

    function handleImageClick(e: MouseEvent) {
        if (!editor) return;

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

        if (el && !isInitialized && doc && !isLoadingLoro) {
            isLoadingLoro = true;
            initializeEditor().finally(() => {
                isLoadingLoro = false;
            });
        }
    });

    $effect(() => {
        const doc = document;

        if (doc && editor && loroDoc && isInitialized && doc.id !== currentDocId) {
            isLoadingLoro = true;
            initializeEditor().finally(() => {
                isLoadingLoro = false;
            });
        }
    });

    onMount(() => {
        initialViewportHeight = window.innerHeight;
        window.visualViewport?.addEventListener('resize', handleViewportChange);
        window.visualViewport?.addEventListener('scroll', handleViewportChange);
    });

    onDestroy(() => {
        window.visualViewport?.removeEventListener('resize', handleViewportChange);
        window.visualViewport?.removeEventListener('scroll', handleViewportChange);

        if (editor) {
            editor.view.dom.removeEventListener('click', handleImageClick);
            editor.destroy();
        }

        loroDoc = null;
    });
</script>

<div class="editor-instance" style="padding-bottom: {keyboardOpen ? keyboardHeight : 0}px;">
    {#if isLoadingLoro}
        <div class="loading-editor">
            <p>Loading editor...</p>
        </div>
    {/if}
    <div class="editor-content" bind:this={element}></div>
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

    .editor-content :global(h1) { font-size: 2em; margin: 0.67em 0; color: var(--text-primary); }
    .editor-content :global(h2) { font-size: 1.5em; margin: 0.83em 0; color: var(--text-primary); }
    .editor-content :global(h3) { font-size: 1.17em; margin: 1em 0; color: var(--text-primary); }
    .editor-content :global(p) { margin: 1em 0; }
    .editor-content :global(ul), .editor-content :global(ol) { margin: 0.3em 0 !important; padding-left: 2em; line-height: 1.7 !important; }
    .editor-content :global(ul li), .editor-content :global(ol li) { line-height: 1.7 !important; margin: 0 !important; }
    .editor-content :global(ul li p), .editor-content :global(ol li p) { margin: 0 !important; line-height: 1.7 !important; }
    .editor-content :global(code) { background: var(--code-bg); color: var(--text-primary); padding: 2px 4px; border-radius: 3px; }
    .editor-content :global(pre) { background: var(--code-bg); color: var(--text-primary); padding: 16px; border-radius: 6px; overflow-x: auto; }
    .editor-content :global(blockquote) { border-left: 4px solid var(--border-light); margin: 1em 0; padding-left: 1em; color: var(--text-secondary); }
    .editor-content :global(a) { color: var(--accent-color); text-decoration: underline; }

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

    .editor-content :global(.document-link-icon) { font-size: 12px; }
    .editor-content :global(.document-link-title) { font-weight: 500; }

    .editor-content :global(ul[data-type="taskList"]) {
        list-style: none;
        padding-left: 0;
        margin: 0;
    }

    .editor-content :global(ul[data-type="taskList"] > li) {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        padding: 1px 0;
    }

    .editor-content :global(ul[data-type="taskList"] > li > label) {
        display: flex;
        align-items: flex-start;
        gap: 2px;
        flex-shrink: 0;
    }

    .editor-content :global(ul[data-type="taskList"] > li > div) { flex: 1; }

    .editor-content :global(ul[data-type="taskList"] > li > div > p) {
        margin: 0;
        display: inline;
        line-height: 1.4;
    }

    .editor-content :global(ul[data-type="taskList"] input[type="checkbox"]) {
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

    .editor-content :global(th), .editor-content :global(td) {
        border: 1px solid var(--border-light);
        padding: 8px;
        text-align: left;
        color: var(--text-primary);
    }

    .editor-content :global(th) { background: var(--bg-secondary); }

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
