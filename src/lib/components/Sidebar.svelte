<script lang="ts">
    import { appStore, files, allLinks } from '../stores/app';
    import type { FileEntry } from '../types';

    let { onSelectFile }: { onSelectFile: (path: string) => void } = $props();

    function handleFileClick(path: string) {
        const fileList = $files;
        const file = fileList.find((f: FileEntry) => f.path === path);
        if (file) {
            appStore.setCurrentFile(file);
        }
    }

    function handleLinkClick(title: string) {
        const fileList = $files;
        const file = fileList.find((f: FileEntry) => f.title.toLowerCase() === title.toLowerCase());
        if (file) {
            appStore.setCurrentFile(file);
        }
    }

    let searchInput = $state('');

    function filterFiles(): FileEntry[] {
        const fileList = $files;
        if (!searchInput.trim()) return fileList;
        const query = searchInput.toLowerCase();
        return fileList.filter((f: FileEntry) => f.title.toLowerCase().includes(query));
    }
</script>

<aside class="sidebar">
    <div class="sidebar-header">
        <input
            type="text"
            placeholder="Search files..."
            bind:value={searchInput}
            class="search-input"
        />
    </div>

    <div class="sidebar-section">
        <h3>Files</h3>
        <ul class="file-list">
            {#each filterFiles() as file}
                <li>
                    <button class="file-btn" onclick={() => handleFileClick(file.path)}>
                        {file.title}
                    </button>
                </li>
            {/each}
        </ul>
    </div>

    <div class="sidebar-section">
        <h3>Links</h3>
        <ul class="link-list">
            {#each $allLinks as link}
                <li>
                    <button class="link-btn" onclick={() => handleLinkClick(link)}>
                        [[{link}]]
                    </button>
                </li>
            {/each}
        </ul>
    </div>
</aside>

<style>
    .sidebar {
        width: 250px;
        min-width: 250px;
        background: #f8f9fa;
        border-right: 1px solid #e0e0e0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .sidebar-header {
        padding: 12px;
        border-bottom: 1px solid #e0e0e0;
    }

    .search-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 14px;
    }

    .sidebar-section {
        padding: 12px;
        overflow-y: auto;
    }

    .sidebar-section h3 {
        font-size: 12px;
        text-transform: uppercase;
        color: #666;
        margin: 0 0 8px 0;
    }

    .file-list, .link-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .file-list li, .link-list li {
        margin-bottom: 4px;
    }

    .file-btn, .link-btn {
        width: 100%;
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 14px;
        color: #333;
    }

    .file-btn:hover, .link-btn:hover {
        background: #e9ecef;
    }

    .link-btn {
        color: #0066cc;
        font-family: monospace;
    }
</style>