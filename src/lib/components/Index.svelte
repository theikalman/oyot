<script lang="ts">
    import { appStore, files, allLinks, backlinks } from '../stores/app';
    import { extractTodos } from '../utils/markdown';
    import type { FileEntry } from '../types';

    let { onSelectFile }: { onSelectFile: (path: string) => void } = $props();

    function handleFileClick(file: FileEntry) {
        appStore.setCurrentFile(file);
    }

    function getTodosForFiles(): { file: FileEntry; todos: { line: number; text: string }[] }[] {
        const fileList = $files;
        return fileList.map(f => ({
            file: f,
            todos: extractTodos(f.content)
        })).filter(item => item.todos.length > 0);
    }

    let allTodos = $derived(getTodosForFiles());
    let indexType = $derived($appStore.indexType);
</script>

<div class="index">
    <div class="index-content">
        {#if indexType === 'files'}
            <div class="index-section">
                <h2>All Files</h2>
                <div class="card-grid">
                    {#each $files as file}
                        <button class="card" onclick={() => handleFileClick(file)}>
                            <h3>{file.title}</h3>
                            <p class="card-path">{file.path}</p>
                        </button>
                    {/each}
                </div>
            </div>
        {:else if indexType === 'links'}
            <div class="index-section">
                <h2>All Links</h2>
                <ul class="link-list">
                    {#each $allLinks as link}
                        {@const linkedFiles = $backlinks.filter(b => b.target.toLowerCase() === link.toLowerCase())}
                        <li class="link-item">
                            <span class="link-title">[[{link}]]</span>
                            <span class="link-count">Referenced in {linkedFiles.length} file(s)</span>
                        </li>
                    {/each}
                </ul>
            </div>
        {:else if indexType === 'todos'}
            <div class="index-section">
                <h2>All TODOs</h2>
                {#if allTodos.length === 0}
                    <p class="empty-message">No TODOs found</p>
                {:else}
                    {#each allTodos as item}
                        <div class="todo-group">
                            <h3>
                                <button class="file-link" onclick={() => handleFileClick(item.file)}>
                                    {item.file.title}
                                </button>
                            </h3>
                            <ul class="todo-items">
                                {#each item.todos as todo}
                                    <li>
                                        <span class="todo-line">Line {todo.line}:</span>
                                        {todo.text}
                                    </li>
                                {/each}
                            </ul>
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .index {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .index-content {
        flex: 1;
        padding: 24px;
        overflow-y: auto;
    }

    .index-section h2 {
        margin: 0 0 16px 0;
        font-size: 20px;
    }

    .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 16px;
    }

    .card {
        padding: 16px;
        background: white;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        cursor: pointer;
        text-align: left;
        transition: box-shadow 0.2s;
    }

    .card:hover {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }

    .card h3 {
        margin: 0 0 8px 0;
        font-size: 16px;
        color: #333;
    }

    .card-path {
        margin: 0;
        font-size: 12px;
        color: #999;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .link-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .link-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        border-bottom: 1px solid #f0f0f0;
    }

    .link-title {
        font-family: monospace;
        color: #0066cc;
    }

    .link-count {
        font-size: 12px;
        color: #999;
    }

    .todo-group {
        margin-bottom: 24px;
    }

    .todo-group h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
    }

    .file-link {
        background: none;
        border: none;
        color: #0066cc;
        cursor: pointer;
        padding: 0;
        font-size: inherit;
    }

    .file-link:hover {
        text-decoration: underline;
    }

    .todo-items {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .todo-items li {
        padding: 8px 12px;
        background: #fffbe6;
        border-radius: 4px;
        margin-bottom: 8px;
    }

    .todo-line {
        color: #999;
        font-size: 12px;
        margin-right: 8px;
    }

    .empty-message {
        color: #999;
        text-align: center;
        padding: 40px;
    }
</style>