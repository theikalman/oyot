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
    import { LoroApp } from '$lib/loro/loroApp';
    import { TiptapBinding, createInitialContent, isEmptyContent } from '$lib/loro/tiptapBinding';
    import type { Document } from '$lib/types';

    interface Props {
        document: Document | null;
        autoSave?: boolean;
        debounceMs?: number;
        onEditorReady?: (editor: EditorType, loroApp: LoroApp) => void;
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
    let loroApp = $state.raw<LoroApp | null>(null);
    let tiptapBinding = $state.raw<TiptapBinding | null>(null);
    let isInitialized = $state.raw(false);
    let currentDocId = $state.raw<string | null>(null);

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

    let initialViewportHeight = 0;
    let keyboardOpen = $state(false);
    let keyboardHeight = $state(0);

    async function initializeEditor() {
        if (!element) return false;

        if (loroApp) {
            loroApp.destroy();
            loroApp = null;
        }
        if (tiptapBinding) {
            tiptapBinding.destroy();
            tiptapBinding = null;
        }
        if (editor) {
            editor.destroy();
            editor = null;
        }

        const newLoroApp = new LoroApp();
        try {
            await newLoroApp.init();
        } catch (error) {
            console.error('[EditorInstance] Failed to init LoroApp:', error);
            return false;
        }

        const title = document?.title ?? 'Untitled';
        let initialContent: object = createInitialContent(title) as object;

        if (document && document.crdt_state.length > 0) {
            try {
                const crdtState = new Uint8Array(document.crdt_state);
                newLoroApp.loadDocument(crdtState);
                const content = newLoroApp.getJsonContent();
                if (content && !isEmptyContent(content)) {
                    initialContent = JSON.parse(content);
                }
            } catch (error) {
                console.error('[EditorInstance] Failed to load document:', error);
            }
        }

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
                ScrollOnFocus
            ],
            content: initialContent,
            editable: true,
            onUpdate: () => {
                if (autoSave && editor) {
                    onContentChange?.();
                }
            }
        });

        const binding = new TiptapBinding({
            editor: ed,
            loroApp: newLoroApp
        });

        ed.view.dom.addEventListener('click', handleImageClick);

        registerDocumentLinkCommand(ed);
        registerDateCommand(ed);
        registerTodoCommand(ed);
        registerImageCommand(ed);

        loroApp = newLoroApp;
        editor = ed;
        tiptapBinding = binding;
        isInitialized = true;
        currentDocId = document?.id ?? null;

        onEditorReady?.(ed, newLoroApp);
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

        if (el && !isInitialized && doc) {
            initializeEditor();
        }
    });

    $effect(() => {
        const doc = document;

        if (doc && editor && loroApp && isInitialized && doc.id !== currentDocId) {
            try {
                const crdtState = new Uint8Array(doc.crdt_state);
                loroApp.loadDocument(crdtState);
                const content = loroApp.getJsonContent();
                if (content && !isEmptyContent(content)) {
                    editor.commands.setContent(JSON.parse(content));
                }
                currentDocId = doc.id;
            } catch (error) {
                console.error('[EditorInstance] Failed to load document:', error);
            }
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

        if (tiptapBinding) {
            tiptapBinding.destroy();
        }

        if (loroApp) {
            loroApp.destroy();
        }
    });
</script>

<div class="editor-instance" style="padding-bottom: {keyboardOpen ? keyboardHeight : 0}px;">
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
</style>