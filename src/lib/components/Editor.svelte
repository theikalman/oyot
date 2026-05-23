<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from "@tauri-apps/api/core";
    import { listen } from "@tauri-apps/api/event";
    import { appStore, currentDocument, documents } from '../stores/app';
    import type { Document, DocumentSummary } from '../types';
    import { Editor } from '@tiptap/core';
    import type { Editor as EditorType } from '@tiptap/core';
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
    import { SlashCommand } from '../tiptap/SlashCommand';
    import { DocumentLinkNode } from '../tiptap/nodes/DocumentLinkNode';
    import { registerDocumentLinkCommand, registerDateCommand, registerTodoCommand, registerImageCommand, insertImageFromFile, commandRegistry } from '../tiptap';
    import { ResizableImage } from '../tiptap/extensions/ResizableImage';
    import { ImageExtension } from '../tiptap/extensions/ImageExtension';
    import { Extension } from '@tiptap/core';
    import { LoroApp, bytesToJson } from '../loro/loroApp';
    import { TiptapBinding, createInitialContent, isEmptyContent } from '../loro/tiptapBinding';

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

    let editorElement = $state<HTMLDivElement>();
    let editor: EditorType | null = null;
    let loroApp: LoroApp | null = null;
    let tiptapBinding: TiptapBinding | null = null;
    let isSaving = $state(false);
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    let previousDocId = $state<string | null>(null);
    let hasUnsavedChanges = $state(false);
    let keyboardOpen = $state(false);
    let keyboardHeight = $state(0);
    let initialViewportHeight = $state(0);
    let unlistenSyncEvent: (() => void) | null = null;

    let current = $derived($currentDocument);
    let docs = $derived($documents);

    function handleOpenDocument(event: Event) {
        const customEvent = event as CustomEvent<{ id: string }>;
        const docId = customEvent.detail?.id;
        if (docId) {
            invoke<Document>('get_document', { docId }).then(fullDoc => {
                appStore.setCurrentDocument(fullDoc);
            }).catch(err => console.error('Failed to load document:', err));
        }
    }

    async function initLoro() {
        if (!loroApp) {
            loroApp = new LoroApp();
            await loroApp.init();
        }
    }

    onMount(async () => {
        window.addEventListener('openDocument', handleOpenDocument);
        initialViewportHeight = window.innerHeight;
        window.visualViewport?.addEventListener('resize', handleViewportChange);
        window.visualViewport?.addEventListener('scroll', handleViewportChange);

        await initLoro();

        unlistenSyncEvent = await listen('sync-received', async (event) => {
            console.log('[Editor] Received sync event:', event);
            const docId = (event.payload as { docId?: string })?.docId;
            if (docId && docId === current?.id) {
                await reloadCurrentDocument();
            }
        });
    });

    onDestroy(() => {
        window.removeEventListener('openDocument', handleOpenDocument);
        window.visualViewport?.removeEventListener('resize', handleViewportChange);
        window.visualViewport?.removeEventListener('scroll', handleViewportChange);
        unlistenSyncEvent?.();
    });

    function handleViewportChange() {
        const vp = window.visualViewport;
        if (!vp) return;
        keyboardOpen = vp.height < initialViewportHeight - 100;
        keyboardHeight = keyboardOpen ? initialViewportHeight - vp.height : 0;
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

    function initEditor(content: string, title: string) {
        if (editor) {
            editor.destroy();
        }
        if (tiptapBinding) {
            tiptapBinding.destroy();
            tiptapBinding = null;
        }

        let initialContent: object;
        try {
            if (isEmptyContent(content)) {
                initialContent = createInitialContent(title) as object;
            } else {
                initialContent = JSON.parse(content);
            }
        } catch {
            initialContent = createInitialContent(title) as object;
        }

        const ed = new Editor({
            element: editorElement,
            extensions: [
                StarterKit,
                ResizableImage.configure({
                    inline: false,
                    allowBase64: true,
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
            onTransaction: ({ editor: txnEditor, transaction }) => {
                if (transaction.selectionSet) {
                    const sel = txnEditor.state.selection;
                    console.log('[Editor] Selection set:', sel.from, '->', sel.to, 'node:', sel.$anchor.node()?.type?.name);
                }
            },
            onUpdate: ({ editor: updatedEditor }) => {
                hasUnsavedChanges = true;
                if (saveTimeout) {
                    clearTimeout(saveTimeout);
                }
                saveTimeout = setTimeout(() => {
                    if (current && loroApp && tiptapBinding) {
                        saveContent();
                    }
                }, 1000);
            }
        });

        editor = ed;

        if (loroApp) {
            tiptapBinding = new TiptapBinding({
                editor: ed,
                loroApp: loroApp
            });
        }

        ed.view.dom.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName !== 'IMG') return;
            e.preventDefault();
            e.stopPropagation();
            const pos = ed.view.posAtDOM(target, 0);
            console.log('[Editor] Image click, pos:', pos);
            if (typeof pos === 'number') {
                const tr = ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, pos));
                ed.view.dispatch(tr);
                const selType = ed.state.selection.constructor.name;
                const selFrom = ed.state.selection.from;
                const selTo = ed.state.selection.to;
                console.log('[Editor] After dispatch - selection type:', selType, 'from:', selFrom, 'to:', selTo);
                const selectedNode = ed.view.dom.querySelector('.ProseMirror-selectednode');
                console.log('[Editor] Selected node DOM:', selectedNode, 'classList:', selectedNode?.classList.toString(), 'innerHTML:', selectedNode?.innerHTML?.substring(0, 200));
                requestAnimationFrame(() => {
                    const selectedNode2 = ed.view.dom.querySelector('.ProseMirror-selectednode');
                    const children = (selectedNode2 as HTMLElement)?.children;
                    console.log('[Editor] After rAF - selected node:', selectedNode2, 'children:', children?.length, 'child HTML:', children?.[0]?.outerHTML?.substring(0, 300));
                });
            }
        });

        registerDocumentLinkCommand(ed);
        registerDateCommand(ed);
        registerTodoCommand(ed);
        registerImageCommand(ed);
        console.log('Commands registered, registry has:', commandRegistry.getAllCommands().length);
    }

    async function saveContent() {
        if (!editor || !current || !loroApp) return;

        isSaving = true;
        try {
            const update = loroApp.getUpdate();
            const crdtState = Array.from(update);

            const updatedDoc: Document = await invoke('save_crdt_update', {
                docId: current.id,
                update: crdtState
            });

            const metadata = loroApp.getMetadata();
            const summary: DocumentSummary = {
                id: updatedDoc.id,
                doc_type: updatedDoc.doc_type,
                title: metadata.title || updatedDoc.title,
                todo_count: metadata.todo_count,
                completed_todo_count: metadata.completed_todo_count,
                created_at: updatedDoc.created_at,
                updated_at: updatedDoc.updated_at
            };
            appStore.updateDocumentInList(summary);
        } catch (error) {
            console.error('Failed to save:', error);
        } finally {
            isSaving = false;
        }
    }

    function handleBack() {
        appStore.setCurrentDocument(null);
    }

    $effect(() => {
        if (!current || !editorElement) {
            if (editor) {
                editor.destroy();
                editor = null;
            }
            if (tiptapBinding) {
                tiptapBinding.destroy();
                tiptapBinding = null;
            }
            return;
        }

        if (previousDocId && previousDocId !== current.id && hasUnsavedChanges && editor && loroApp) {
            const prevDoc = docs.find((d: DocumentSummary) => d.id === previousDocId);
            const loroRef = loroApp;
            if (prevDoc) {
                const update = loroRef.getUpdate();
                const crdtState = Array.from(update);
                invoke('save_crdt_update', {
                    docId: prevDoc.id,
                    update: crdtState
                }).then(() => {
                    const metadata = loroRef.getMetadata();
                    const summary: DocumentSummary = {
                        ...prevDoc,
                        title: metadata.title || prevDoc.title,
                        todo_count: metadata.todo_count,
                        completed_todo_count: metadata.completed_todo_count
                    };
                    appStore.updateDocumentInList(summary);
                }).catch(err => console.error('Failed to save previous document:', err));
            }
        }

        previousDocId = current.id;
        hasUnsavedChanges = false;
        const currentLoro = loroApp;
        if (currentLoro) {
            const crdtState = new Uint8Array(current.crdt_state);
            currentLoro.loadDocument(crdtState);
            const content = currentLoro.getJsonContent();
            initEditor(content, current.title);
        } else {
            const contentJson = bytesToJson(current.crdt_state);
            initEditor(contentJson, current.title);
        }
    });

    onDestroy(() => {
        if (editor) {
            editor.destroy();
        }
        if (tiptapBinding) {
            tiptapBinding.destroy();
        }
        if (loroApp) {
            loroApp.destroy();
        }
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
    });
</script>

<div class="editor-container">
    <div class="editor-header">
        {#if current}
            <h1>{current.title}</h1>
        {/if}
        <div class="header-actions">
            {#if isSaving}
                <span class="saving-indicator">Saving...</span>
            {/if}
        </div>
    </div>

    {#if current}
        <div class="toolbar visible">
            <button onclick={() => editor?.chain().focus().toggleBold().run()} title="Bold">
                <strong>B</strong>
            </button>
            <button onclick={() => editor?.chain().focus().toggleItalic().run()} title="Italic">
                <em>I</em>
            </button>
            <button onclick={() => editor?.chain().focus().toggleStrike().run()} title="Strikethrough">
                <s>S</s>
            </button>
            <span class="separator"></span>
            <button onclick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1">
                H1
            </button>
            <button onclick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
                H2
            </button>
            <button onclick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
                H3
            </button>
            <span class="separator"></span>
            <button onclick={() => editor?.chain().focus().toggleBulletList().run()} title="Bullet List">
                •
            </button>
            <button onclick={() => editor?.chain().focus().toggleOrderedList().run()} title="Ordered List">
                1.
            </button>
            <button onclick={() => editor?.chain().focus().toggleTaskList().run()} title="Task List">
                ☑
            </button>
            <span class="separator"></span>
            <button onclick={() => editor?.chain().focus().toggleBlockquote().run()} title="Quote">
                "
            </button>
            <button onclick={() => editor?.chain().focus().toggleCodeBlock().run()} title="Code Block">
                &lt;/&gt;
            </button>
            <button onclick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3 }).run()} title="Table">
                ⊞
            </button>
            <button onclick={() => insertImageFromFile(editor!)} title="Insert Image">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A1A1A1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m4.272 20.728 6.597-6.597c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668l6.553 6.553M14 15l2.869-2.869c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668L22 15M10 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6.8 21h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 18.72 22 17.88 22 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 3 18.88 3 17.2 3H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 5.28 2 6.12 2 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 21 5.12 21 6.8 21"/>
                </svg>
            </button>
            <span class="separator"></span>
            <button onclick={() => editor?.chain().focus().undo().run()} title="Undo">
                ↩
            </button>
            <button onclick={() => editor?.chain().focus().redo().run()} title="Redo">
                ↪
            </button>
        </div>

        <div class="editor-content" bind:this={editorElement}></div>
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

    .editor-header {
        padding: 16px 24px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        gap: 16px;
        background: var(--bg-primary);
    }

    .editor-header h1 {
        margin: 0;
        flex: 1;
        font-size: 24px;
        color: var(--text-primary);
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .saving-indicator {
        font-size: 12px;
        color: var(--text-secondary);
    }

    .toolbar {
        display: flex;
        padding: 8px 16px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border-color);
        gap: 4px;
        flex-wrap: wrap;
    }

    .toolbar button {
        padding: 6px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-light);
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        min-width: 32px;
        color: var(--text-primary);
    }

    .toolbar button:hover {
        background: var(--bg-hover);
    }

    .separator {
        width: 1px;
        background: var(--border-light);
        margin: 0 4px;
    }

    .editor-content {
        flex: 1;
        padding: 24px;
        padding-bottom: max(24px, env(safe-area-inset-bottom));
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

    .editor-content :global(.document-link-icon) {
        font-size: 12px;
    }

    .editor-content :global(.document-link-title) {
        font-weight: 500;
    }

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

    .editor-content :global(ul[data-type="taskList"] > li > div) {
        flex: 1;
    }

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

    .editor-content :global(th) {
        background: var(--bg-secondary);
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
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

    .editor-content :global(.ProseMirror-selectednode[data-resize]) {
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