<script lang="ts">
    import { onMount } from "svelte";
    import { invoke } from "@tauri-apps/api/core";
    import { open } from "@tauri-apps/plugin-dialog";
    import { appStore, workspacePath, isLoading, currentDocument } from "../lib/stores/app";
    import type { IndexData, Document } from "../lib/types";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import Editor from "../lib/components/Editor.svelte";

    let recentWorkspaces = $state<string[]>([]);

    async function initWorkspace(path: string) {
        appStore.setLoading(true);
        try {
            await invoke("init_database", { workspacePath: path });
            const indexData: IndexData = await invoke("get_all_documents", { workspacePath: path });
            appStore.setWorkspacePath(path);
            appStore.setDocuments(indexData.documents);
            appStore.setLinks(indexData.links);
            appStore.setAllLinks(indexData.all_links);
            appStore.setTodos(indexData.todos);

            const todayJournal: Document = await invoke("get_or_create_today_journal", { workspacePath: path });
            appStore.addDocument(todayJournal);
            appStore.setCurrentDocument(todayJournal);

            await invoke("save_recent_workspace", { workspacePath: path });
            recentWorkspaces = await invoke("get_recent_workspaces");
        } catch (error) {
            console.error("Failed to initialize workspace:", error);
        } finally {
            appStore.setLoading(false);
        }
    }

    async function openWorkspace() {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Workspace Directory"
        });

        if (selected && typeof selected === "string") {
            await initWorkspace(selected);
        }
    }

    onMount(async () => {
        try {
            const recents: string[] = await invoke("get_recent_workspaces");
            recentWorkspaces = recents;
            if (recents.length > 0) {
                await initWorkspace(recents[0]);
            }
        } catch (error) {
            console.error("Failed to restore last workspace:", error);
        }
    });

    let activeDocument = $derived($currentDocument);

    function workspaceName(path: string): string {
        return path.split("/").filter(Boolean).pop() ?? path;
    }
</script>

<main class="app">
    {#if !$workspacePath}
        <div class="welcome">
            <h1>Welcome to Oyot</h1>
            <p>A lightweight personal knowledge management system</p>
            {#if recentWorkspaces.length > 0}
                <div class="recent-list">
                    <p class="recent-label">Recent workspaces</p>
                    {#each recentWorkspaces as path}
                        <button class="recent-item" onclick={() => initWorkspace(path)}>
                            <span class="recent-name">{workspaceName(path)}</span>
                            <span class="recent-path">{path}</span>
                        </button>
                    {/each}
                </div>
                <button class="browse-btn" onclick={openWorkspace}>Browse...</button>
            {:else}
                <button class="open-workspace-btn" onclick={openWorkspace}>
                    Open Workspace
                </button>
            {/if}
        </div>
    {:else}
        <div class="workspace">
            <Sidebar onSwitchWorkspace={initWorkspace} />
            <div class="main-content">
                {#if activeDocument}
                    <Editor />
                {:else}
                    <div class="empty-state">
                        <p>Select a document to edit</p>
                    </div>
                {/if}
            </div>
        </div>
    {/if}

    {#if $isLoading}
        <div class="loading-overlay">
            <div class="loading-spinner"></div>
            <p>Loading...</p>
        </div>
    {/if}
</main>

<style>
    :global(*) {
        box-sizing: border-box;
    }

    :global(body) {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    }

    .app {
        height: 100vh;
        display: flex;
        flex-direction: column;
    }

    /* ── Welcome screen ── */
    .welcome {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 40px;
    }

    .welcome h1 {
        margin: 0 0 16px 0;
        font-size: 32px;
        color: #333;
    }

    .welcome > p {
        margin: 0 0 32px 0;
        color: #666;
    }

    .open-workspace-btn {
        padding: 12px 24px;
        background: #0066cc;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 16px;
        cursor: pointer;
    }

    .open-workspace-btn:hover {
        background: #0055aa;
    }

    /* ── Recent list on welcome screen ── */
    .recent-list {
        width: 100%;
        max-width: 420px;
        margin-bottom: 16px;
        text-align: left;
    }

    .recent-label {
        font-size: 12px;
        text-transform: uppercase;
        color: #999;
        margin: 0 0 8px 0;
        letter-spacing: 0.05em;
    }

    .recent-item {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 10px 12px;
        margin-bottom: 4px;
        background: #f8f9fa;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
    }

    .recent-item:hover {
        background: #e9f0fb;
        border-color: #0066cc;
    }

    .recent-name {
        font-size: 14px;
        font-weight: 600;
        color: #333;
    }

    .recent-path {
        font-size: 11px;
        color: #999;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .browse-btn {
        padding: 8px 16px;
        background: #f0f0f0;
        color: #333;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 14px;
        cursor: pointer;
    }

    .browse-btn:hover {
        background: #e0e0e0;
    }

    /* ── Workspace layout ── */
    .workspace {
        flex: 1;
        display: flex;
        overflow: hidden;
    }

    .main-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #999;
    }

    /* ── Loading overlay ── */
    .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255, 255, 255, 0.9);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid #f3f3f3;
        border-top: 4px solid #0066cc;
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }

    .loading-overlay p {
        margin-top: 16px;
        color: #666;
    }
</style>
