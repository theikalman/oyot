<script lang="ts">
    import { appStore, currentFile } from '../stores/app';
    import { parseMarkdown, extractTodos } from '../utils/markdown';
    import type { FileEntry } from '../types';

    let renderedHtml = $state('');
    let todos = $state<{ line: number; text: string }[]>([]);

    async function renderContent(file: FileEntry | null) {
        if (!file) {
            renderedHtml = '';
            todos = [];
            return;
        }

        const html = await parseMarkdown(file.content);
        renderedHtml = html;
        todos = extractTodos(file.content);
    }

    function handleBack() {
        appStore.setViewMode('index');
        appStore.setCurrentFile(null);
    }

    function handleWikilinkClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (target.classList.contains('wikilink')) {
            event.preventDefault();
            const title = target.getAttribute('data-title');
            if (title) {
                const fileList = $appStore.files;
                const targetFile = fileList.find(f => f.title.toLowerCase() === title.toLowerCase());
                if (targetFile) {
                    appStore.setCurrentFile(targetFile);
                }
            }
        }
    }

    $effect(() => {
        renderContent($currentFile);
    });
</script>

<div class="reader">
    <div class="reader-header">
        <button class="back-btn" onclick={handleBack}>← Back to Index</button>
        {#if $currentFile}
            <h1>{$currentFile.title}</h1>
        {/if}
    </div>

    {#if $currentFile}
        <div class="reader-content" onclick={handleWikilinkClick}>
            {@html renderedHtml}
        </div>

        {#if todos.length > 0}
            <div class="reader-todos">
                <h3>TODO</h3>
                <ul>
                    {#each todos as todo}
                        <li>
                            <span class="todo-line">Line {todo.line}:</span>
                            {todo.text}
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}
    {:else}
        <div class="empty-state">
            <p>Select a file to read</p>
        </div>
    {/if}
</div>

<style>
    .reader {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .reader-header {
        padding: 16px 24px;
        border-bottom: 1px solid #e0e0e0;
    }

    .back-btn {
        padding: 8px 16px;
        background: #f0f0f0;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-bottom: 12px;
    }

    .back-btn:hover {
        background: #e0e0e0;
    }

    .reader-header h1 {
        margin: 0;
        font-size: 24px;
    }

    .reader-content {
        flex: 1;
        padding: 24px;
        overflow-y: auto;
        line-height: 1.6;
    }

    .reader-content :global(h1) { font-size: 2em; margin: 0.67em 0; }
    .reader-content :global(h2) { font-size: 1.5em; margin: 0.83em 0; }
    .reader-content :global(h3) { font-size: 1.17em; margin: 1em 0; }
    .reader-content :global(p) { margin: 1em 0; }
    .reader-content :global(ul), .reader-content :global(ol) { margin: 1em 0; padding-left: 2em; }
    .reader-content :global(code) { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
    .reader-content :global(pre) { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
    .reader-content :global(blockquote) { border-left: 4px solid #ddd; margin: 1em 0; padding-left: 1em; color: #666; }
    .reader-content :global(.wikilink) { color: #0066cc; cursor: pointer; text-decoration: underline; }
    .reader-content :global(.wikilink:hover) { color: #004499; }

    .reader-todos {
        padding: 16px 24px;
        background: #fffbe6;
        border-top: 1px solid #e0e0e0;
    }

    .reader-todos h3 {
        margin: 0 0 12px 0;
        font-size: 14px;
        text-transform: uppercase;
        color: #666;
    }

    .reader-todos ul {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .reader-todos li {
        padding: 4px 0;
        font-size: 14px;
    }

    .todo-line {
        color: #999;
        font-size: 12px;
        margin-right: 8px;
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #999;
    }
</style>