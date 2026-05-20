<script lang="ts">
    import { appStore, documents, allLinks, workspacePath } from '../stores/app';
    import type { Document } from '../types';
    import { invoke } from "@tauri-apps/api/core";

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
    let showModal = $state(false);
    let newDocTitle = $state('');
    let collapsed = $state(false);

    function filterDocs(): Document[] {
        const docList = $documents;
        if (!searchInput.trim()) return docList;
        const query = searchInput.toLowerCase();
        return docList.filter((d: Document) => d.title.toLowerCase().includes(query));
    }

    let wsPath = $derived($workspacePath);

    async function createDocument() {
        if (!newDocTitle.trim() || !wsPath) return;
        
        try {
            const newDoc: Document = await invoke('create_document', {
                workspacePath: wsPath,
                docType: 'note',
                title: newDocTitle.trim(),
                contentJson: '{}'
            });
            
            appStore.addDocument(newDoc);
            appStore.setCurrentDocument(newDoc);
            
            newDocTitle = '';
            showModal = false;
        } catch (error) {
            console.error('Failed to create document:', error);
        }
    }

    function closeModal() {
        newDocTitle = '';
        showModal = false;
    }
</script>

<aside class="sidebar" class:collapsed>
    <div class="sidebar-header">
        {#if !collapsed}
            <input
                type="text"
                placeholder="Search documents..."
                bind:value={searchInput}
                class="search-input"
            />
        {/if}
        <button class="toggle-btn" onclick={() => collapsed = !collapsed} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '▶' : '◀'}
        </button>
    </div>

    {#if !collapsed}
        <div class="sidebar-section">
            <h3>
                Documents
                <button class="add-doc-btn" onclick={() => showModal = true}>+</button>
            </h3>
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
    {/if}
</aside>

{#if showModal}
    <div class="modal-overlay" role="presentation" onclick={closeModal}>
        <div class="modal-content" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && closeModal()}>
            <h3>New Document</h3>
            <input
                type="text"
                bind:value={newDocTitle}
                placeholder="Enter file name..."
                class="modal-input"
                onkeydown={(e) => e.key === 'Enter' && createDocument()}
            />
            <div class="modal-actions">
                <button class="modal-btn" onclick={createDocument}>OK</button>
            </div>
        </div>
    </div>
{/if}

<style>
    .sidebar {
        width: 250px;
        min-width: 250px;
        background: #f8f9fa;
        border-right: 1px solid #e0e0e0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: width 0.2s ease, min-width 0.2s ease;
    }

    .sidebar.collapsed {
        width: 40px;
        min-width: 40px;
    }

    .sidebar-header {
        padding: 12px;
        border-bottom: 1px solid #e0e0e0;
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .sidebar.collapsed .sidebar-header {
        justify-content: center;
        padding: 12px 8px;
    }

    .toggle-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 14px;
        padding: 4px 8px;
        color: #666;
        border-radius: 4px;
    }

    .toggle-btn:hover {
        background: #e9ecef;
        color: #333;
    }

    .sidebar.collapsed .search-input {
        display: none;
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

    .sidebar-section h3 {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .add-doc-btn {
        background: none;
        border: none;
        color: #666;
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
    }

    .add-doc-btn:hover {
        color: #333;
    }

    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .modal-content {
        background: white;
        padding: 20px;
        border-radius: 8px;
        min-width: 300px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    }

    .modal-content h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: #333;
    }

    .modal-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 14px;
        box-sizing: border-box;
    }

    .modal-actions {
        margin-top: 12px;
        display: flex;
        justify-content: flex-end;
    }

    .modal-btn {
        padding: 6px 16px;
        background: #007bff;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    }

    .modal-btn:hover {
        background: #0056b3;
    }
</style>
