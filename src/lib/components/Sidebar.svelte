<script lang="ts">
    import { appStore, documents, allLinks } from '../stores/app';
    import type { Document } from '../types';

    function handleDocClick(doc: Document) {
        appStore.setCurrentDocument(doc);
    }

    function handleLinkClick(title: string) {
        const docList = $documents;
        const doc = docList.find((d: Document) => d.title.toLowerCase() === title.toLowerCase());
        if (doc) {
            appStore.setCurrentDocument(doc);
        }
    }

    let searchInput = $state('');

    function filterDocs(): Document[] {
        const docList = $documents;
        if (!searchInput.trim()) return docList;
        const query = searchInput.toLowerCase();
        return docList.filter((d: Document) => d.title.toLowerCase().includes(query));
    }
</script>

<aside class="sidebar">
    <div class="sidebar-header">
        <input
            type="text"
            placeholder="Search documents..."
            bind:value={searchInput}
            class="search-input"
        />
    </div>

    <div class="sidebar-section">
        <h3>Documents</h3>
        <ul class="doc-list">
            {#each filterDocs() as doc}
                <li>
                    <button class="doc-btn" onclick={() => handleDocClick(doc)}>
                        <span class="doc-type">{doc.doc_type === 'journal' ? '📅' : '📝'}</span>
                        {doc.title}
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

    .doc-list, .link-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .doc-list li, .link-list li {
        margin-bottom: 4px;
    }

    .doc-btn, .link-btn {
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

    .doc-btn:hover, .link-btn:hover {
        background: #e9ecef;
    }

    .link-btn {
        color: #0066cc;
        font-family: monospace;
    }

    .doc-type {
        margin-right: 6px;
    }
</style>