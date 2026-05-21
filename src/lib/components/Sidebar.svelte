<script lang="ts">
    import { appStore, documents, allLinks, workspacePath, theme } from '../stores/app';
    import type { Document, Theme } from '../types';
    import { invoke } from "@tauri-apps/api/core";
    import { open } from "@tauri-apps/plugin-dialog";

    let { onSwitchWorkspace }: { onSwitchWorkspace: (path: string) => Promise<void> } = $props();

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
    let showWorkspacePicker = $state(false);
    let recentWorkspaces = $state<string[]>([]);

    function filterDocs(): Document[] {
        const docList = $documents;
        if (!searchInput.trim()) return docList;
        const query = searchInput.toLowerCase();
        return docList.filter((d: Document) => d.title.toLowerCase().includes(query));
    }

    let wsPath = $derived($workspacePath);
    let currentTheme = $derived($theme);

    function workspaceName(path: string): string {
        return path.split("/").filter(Boolean).pop() ?? path;
    }

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

    async function openSwitchPicker() {
        recentWorkspaces = await invoke("get_recent_workspaces");
        showWorkspacePicker = true;
    }

    async function switchToRecent(path: string) {
        showWorkspacePicker = false;
        appStore.reset();
        await onSwitchWorkspace(path);
    }

    async function browseNewWorkspace() {
        showWorkspacePicker = false;
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Workspace Directory"
        });
        if (selected && typeof selected === "string") {
            appStore.reset();
            await onSwitchWorkspace(selected);
        }
    }

    async function toggleTheme() {
        const next: Theme = currentTheme === 'light' ? 'dark' : 'light';
        appStore.setTheme(next);
        try {
            await invoke('save_theme', { theme: next });
        } catch (error) {
            console.error('Failed to save theme:', error);
        }
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
        <div class="sidebar-content">
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
        </div>

        <div class="sidebar-footer">
            <button class="switch-workspace-btn" onclick={openSwitchPicker}>
                Switch Workspace
            </button>
            <button
                class="theme-toggle-btn"
                onclick={toggleTheme}
                title={currentTheme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
                {currentTheme === 'light' ? '☾' : '☀'}
            </button>
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

{#if showWorkspacePicker}
    <div class="modal-overlay" role="presentation" onclick={() => showWorkspacePicker = false}>
        <div class="modal-content picker-modal" role="dialog" tabindex="-1"
             onclick={(e) => e.stopPropagation()}
             onkeydown={(e) => e.key === 'Escape' && (showWorkspacePicker = false)}>
            <h3>Switch Workspace</h3>
            {#if recentWorkspaces.length > 0}
                <ul class="picker-list">
                    {#each recentWorkspaces as path}
                        <li>
                            <button
                                class="picker-item"
                                class:picker-item-current={path === $workspacePath}
                                onclick={() => switchToRecent(path)}
                            >
                                <span class="picker-name">{workspaceName(path)}</span>
                                <span class="picker-path">{path}</span>
                                {#if path === $workspacePath}
                                    <span class="picker-badge">current</span>
                                {/if}
                            </button>
                        </li>
                    {/each}
                </ul>
            {:else}
                <p class="picker-empty">No recent workspaces.</p>
            {/if}
            <div class="picker-footer">
                <button class="browse-btn" onclick={browseNewWorkspace}>Browse...</button>
                <button class="cancel-btn" onclick={() => showWorkspacePicker = false}>Cancel</button>
            </div>
        </div>
    </div>
{/if}

<style>
    .sidebar {
        width: 250px;
        min-width: 250px;
        background: var(--bg-secondary);
        border-right: 1px solid var(--border-color);
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
        border-bottom: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
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
        color: var(--text-secondary);
        border-radius: 4px;
    }

    .toggle-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .sidebar.collapsed .search-input {
        display: none;
    }

    .search-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        background: var(--bg-primary);
        color: var(--text-primary);
    }

    .search-input::placeholder {
        color: var(--text-muted);
    }

    /* scrollable middle area */
    .sidebar-content {
        flex: 1;
        overflow-y: auto;
    }

    .sidebar-section {
        padding: 12px;
    }

    .sidebar-section h3 {
        font-size: 12px;
        text-transform: uppercase;
        color: var(--text-secondary);
        margin: 0 0 8px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
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
        color: var(--text-primary);
    }

    .doc-btn:hover, .link-btn:hover {
        background: var(--bg-hover);
    }

    .link-btn {
        color: var(--accent-color);
        font-family: monospace;
    }

    .doc-type {
        margin-right: 6px;
    }

    .add-doc-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
    }

    .add-doc-btn:hover {
        color: var(--text-primary);
    }

    /* ── Sidebar footer ── */
    .sidebar-footer {
        flex-shrink: 0;
        padding: 12px;
        border-top: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .switch-workspace-btn {
        flex: 1;
        padding: 8px 12px;
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        text-align: center;
    }

    .switch-workspace-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
        border-color: var(--border-light);
    }

    .theme-toggle-btn {
        flex-shrink: 0;
        padding: 8px 10px;
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 16px;
        cursor: pointer;
        line-height: 1;
    }

    .theme-toggle-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* ── Modals ── */
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .modal-content {
        background: var(--bg-primary);
        padding: 20px;
        border-radius: 8px;
        min-width: 300px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        color: var(--text-primary);
    }

    .picker-modal {
        width: 420px;
        max-width: 90vw;
        min-width: unset;
        padding: 24px;
        border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .modal-content h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: var(--text-primary);
    }

    .modal-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        box-sizing: border-box;
        background: var(--bg-secondary);
        color: var(--text-primary);
    }

    .modal-input::placeholder {
        color: var(--text-muted);
    }

    .modal-actions {
        margin-top: 12px;
        display: flex;
        justify-content: flex-end;
    }

    .modal-btn {
        padding: 6px 16px;
        background: var(--btn-primary-bg);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    }

    .modal-btn:hover {
        background: var(--btn-primary-hover);
    }

    /* ── Workspace picker modal ── */
    .picker-list {
        list-style: none;
        padding: 0;
        margin: 0 0 16px 0;
    }

    .picker-list li {
        margin-bottom: 4px;
    }

    .picker-item {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        position: relative;
    }

    .picker-item:hover {
        background: var(--accent-bg);
        border-color: var(--accent-color);
    }

    .picker-item-current {
        border-color: var(--accent-color);
        background: var(--bg-accent);
    }

    .picker-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .picker-path {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .picker-badge {
        position: absolute;
        top: 10px;
        right: 10px;
        font-size: 10px;
        background: var(--accent-color);
        color: white;
        padding: 2px 6px;
        border-radius: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .picker-empty {
        color: var(--text-muted);
        font-size: 14px;
        margin: 0 0 16px 0;
    }

    .picker-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-top: 1px solid var(--border-color);
        padding-top: 16px;
    }

    .browse-btn {
        padding: 8px 16px;
        background: var(--bg-hover);
        color: var(--text-primary);
        border: 1px solid var(--border-light);
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
    }

    .browse-btn:hover {
        background: var(--border-color);
    }

    .cancel-btn {
        padding: 8px 16px;
        background: transparent;
        color: var(--text-secondary);
        border: none;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
    }

    .cancel-btn:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
    }
</style>
