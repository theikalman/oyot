<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke } from "@tauri-apps/api/core";
    import { appStore, currentDocument, workspacePath, documents } from '../stores/app';
    import type { Document } from '../types';
    import { Editor } from '@tiptap/core';
    import type { Editor as EditorType } from '@tiptap/core';
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
    import { registerDocumentLinkCommand, registerDateCommand, registerTodoCommand, commandRegistry } from '../tiptap';

    let editorElement = $state<HTMLDivElement>();
    let editor: EditorType | null = null;
    let isSaving = $state(false);
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    let previousDocId = $state<string | null>(null);
    let hasUnsavedChanges = $state(false);

    let wsPath = $derived($workspacePath);
    let current = $derived($currentDocument);
    let docs = $derived($documents);

    function handleOpenDocument(event: Event) {
        const customEvent = event as CustomEvent<{ id: string }>;
        const docId = customEvent.detail?.id;
        if (docId) {
            const doc = docs.find((d: Document) => d.id === docId);
            if (doc) {
                appStore.setCurrentDocument(doc);
            }
        }
    }

    onMount(() => {
        window.addEventListener('openDocument', handleOpenDocument);
    });

    onDestroy(() => {
        window.removeEventListener('openDocument', handleOpenDocument);
    });

    function createInitialContent(title: string): any {
        return {
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text: title }]
                },
                {
                    type: 'paragraph',
                    content: []
                }
            ]
        };
    }

    function initEditor(content: string, title: string) {
        if (editor) {
            editor.destroy();
        }

        let initialContent: any;
        try {
            initialContent = JSON.parse(content);
            if (!initialContent.content || initialContent.content.length === 0) {
                initialContent = createInitialContent(title);
            }
        } catch {
            initialContent = createInitialContent(title);
        }

        editor = new Editor({
            element: editorElement,
            extensions: [
                StarterKit,
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
            ],
            content: initialContent,
            editable: true,
            onUpdate: ({ editor }) => {
                hasUnsavedChanges = true;
                if (saveTimeout) {
                    clearTimeout(saveTimeout);
                }
                saveTimeout = setTimeout(() => {
                    if (current && wsPath) {
                        saveContent();
                    }
                }, 1000);
            }
        });

        registerDocumentLinkCommand(editor);
        registerDateCommand(editor);
        registerTodoCommand(editor);
        console.log('Commands registered, registry has:', commandRegistry.getAllCommands().length);
    }

    async function saveContent() {
        if (!editor || !current || !wsPath) return;

        isSaving = true;
        try {
            const content = JSON.stringify(editor.getJSON());
            const updatedDoc: Document = await invoke('update_document', {
                workspacePath: wsPath,
                docId: current.id,
                title: current.title,
                contentJson: content
            });
            appStore.updateDocumentInListOnly(updatedDoc);
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
            return;
        }

        if (previousDocId && previousDocId !== current.id && hasUnsavedChanges && wsPath && editor) {
            const prevDoc = docs.find((d: Document) => d.id === previousDocId);
            if (prevDoc) {
                const content = JSON.stringify(editor.getJSON());
                invoke('update_document', {
                    workspacePath: wsPath,
                    docId: prevDoc.id,
                    title: prevDoc.title,
                    contentJson: content
                }).then(() => {
                    appStore.updateDocumentInListOnly({ ...prevDoc, content_json: content });
                }).catch(err => console.error('Failed to save previous document:', err));
            }
        }

        previousDocId = current.id;
        hasUnsavedChanges = false;
        initEditor(current.content_json, current.title);
    });

    onDestroy(() => {
        if (editor) {
            editor.destroy();
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
        overflow-y: auto;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .editor-content :global(.tiptap) {
        outline: none;
        min-height: 100%;
        color: var(--text-primary);
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
    .editor-content :global(ul), .editor-content :global(ol) { margin: 1em 0; padding-left: 2em; }
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
</style>
