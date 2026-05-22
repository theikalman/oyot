<script lang="ts">
    import { onMount } from "svelte";
    import { invoke } from "@tauri-apps/api/core";
    import { listen } from "@tauri-apps/api/event";
    import { open } from "@tauri-apps/plugin-dialog";
    import { appStore, workspacePath, isLoading, currentDocument, theme, syncStore } from "../lib/stores/app";
    import type { IndexData, Document, DocumentSummary, Theme } from "../lib/types";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import Editor from "../lib/components/Editor.svelte";
    import SyncStatus from "../lib/components/SyncStatus.svelte";

    let recentWorkspaces = $state<string[]>([]);

    async function initWorkspace(path: string) {
        appStore.setLoading(true);
        try {
            await invoke("init_database", { workspacePath: path });
            const indexData: IndexData = await invoke("get_all_documents");
            appStore.setWorkspacePath(path);
            appStore.setDocuments(indexData.documents);

            const todayJournal: Document = await invoke("get_or_create_today_journal");
            const summary: DocumentSummary = {
                id: todayJournal.id,
                doc_type: todayJournal.doc_type,
                title: todayJournal.title,
                todo_count: 0,
                completed_todo_count: 0,
                created_at: todayJournal.created_at,
                updated_at: todayJournal.updated_at
            };
            appStore.addDocument(summary);
            appStore.setCurrentDocument(todayJournal);

            await invoke("save_recent_workspace", { workspacePath: path });
            await invoke("set_current_workspace", { workspacePath: path });
            recentWorkspaces = await invoke("get_recent_workspaces");

            try {
                const deletedCount: number = await invoke("cleanup_orphaned_images");
                if (deletedCount > 0) {
                    console.log(`Cleaned up ${deletedCount} orphaned image(s)`);
                }
            } catch (e) {
                console.error("Failed to cleanup orphaned images:", e);
            }
        } catch (error) {
            console.error("Failed to initialize workspace:", error);
        } finally {
            appStore.setLoading(false);
        }
    }

    async function openWorkspace() {
        try {
            const appDataDir: string = await invoke("get_workspace_dir");
            await initWorkspace(appDataDir);
        } catch (error) {
            console.error("Failed to open workspace:", error);
        }
    }

    onMount(async () => {
        // Load saved theme and apply it
        try {
            const savedTheme: Theme = await invoke("get_theme");
            appStore.setTheme(savedTheme);
            document.body.dataset.theme = savedTheme;
        } catch (error) {
            console.error("Failed to load theme:", error);
            document.body.dataset.theme = "light";
        }

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

    // Reactively apply theme to <body> whenever the store changes
    $effect(() => {
        document.body.dataset.theme = $theme;
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
                <div class="sync-status-container">
                    <SyncStatus />
                </div>
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
    /* ── CSS custom properties (light theme defaults) ── */
    :global(:root) {
        --bg-primary: #ffffff;
        --bg-secondary: #f8f9fa;
        --bg-hover: #e9ecef;
        --bg-accent: #eef4ff;
        --text-primary: #333333;
        --text-secondary: #666666;
        --text-muted: #999999;
        --border-color: #e0e0e0;
        --border-light: #dddddd;
        --accent-color: #0066cc;
        --accent-hover: #0055aa;
        --accent-bg: #e8f0fe;
        --accent-bg-hover: #d2e3fc;
        --btn-primary-bg: #007bff;
        --btn-primary-hover: #0056b3;
        --code-bg: #f4f4f4;
        --loading-overlay-bg: rgba(255, 255, 255, 0.9);
    }

    /* ── Dark theme overrides ── */
    :global([data-theme="dark"]) {
        --bg-primary: #1e1e1e;
        --bg-secondary: #252526;
        --bg-hover: #2d2d2d;
        --bg-accent: #1c3358;
        --text-primary: #e0e0e0;
        --text-secondary: #aaaaaa;
        --text-muted: #666666;
        --border-color: #3d3d3d;
        --border-light: #444444;
        --accent-color: #4da3ff;
        --accent-hover: #73b6ff;
        --accent-bg: #1c3358;
        --accent-bg-hover: #26456e;
        --btn-primary-bg: #0078d4;
        --btn-primary-hover: #006cbf;
        --code-bg: #2d2d2d;
        --loading-overlay-bg: rgba(30, 30, 30, 0.9);
    }

    :global(*) {
        box-sizing: border-box;
    }

    :global(body) {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        background-color: var(--bg-primary);
        color: var(--text-primary);
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
        color: var(--text-primary);
    }

    .welcome > p {
        margin: 0 0 32px 0;
        color: var(--text-secondary);
    }

    .open-workspace-btn {
        padding: 12px 24px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 16px;
        cursor: pointer;
    }

    .open-workspace-btn:hover {
        background: var(--accent-hover);
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
        color: var(--text-muted);
        margin: 0 0 8px 0;
        letter-spacing: 0.05em;
    }

    .recent-item {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 10px 12px;
        margin-bottom: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
    }

    .recent-item:hover {
        background: var(--bg-accent);
        border-color: var(--accent-color);
    }

    .recent-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .recent-path {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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
        background: var(--bg-primary);
    }

    .sync-status-container {
        display: flex;
        justify-content: flex-end;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border-color);
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
    }

    /* ── Loading overlay ── */
    .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--loading-overlay-bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid var(--border-color);
        border-top: 4px solid var(--accent-color);
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }

    .loading-overlay p {
        margin-top: 16px;
        color: var(--text-secondary);
    }
</style>
