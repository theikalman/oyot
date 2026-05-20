<script lang="ts">
    import { invoke } from "@tauri-apps/api/core";
    import { open } from "@tauri-apps/plugin-dialog";
    import { appStore, viewMode, workspacePath, isLoading } from "../lib/stores/app";
    import type { IndexData, FileEntry } from "../lib/types";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import Reader from "../lib/components/Reader.svelte";
    import Index from "../lib/components/Index.svelte";

    async function openWorkspace() {
        const selected = await open({
            directory: true,
            multiple: false,
            title: "Select Workspace Directory"
        });

        if (selected && typeof selected === "string") {
            appStore.setLoading(true);
            try {
                const indexData: IndexData = await invoke("scan_directory", { dirPath: selected });
                appStore.setWorkspacePath(selected);
                appStore.setFiles(indexData.files);
                appStore.setBacklinks(indexData.backlinks);
                appStore.setAllLinks(indexData.all_links);
            } catch (error) {
                console.error("Failed to scan directory:", error);
            } finally {
                appStore.setLoading(false);
            }
        }
    }

    function handleSelectFile(path: string) {
        const files = $appStore.files;
        const file = files.find((f: FileEntry) => f.path === path);
        if (file) {
            appStore.setCurrentFile(file);
        }
    }
</script>

<main class="app">
    {#if !$workspacePath}
        <div class="welcome">
            <h1>Welcome to Oyot</h1>
            <p>A lightweight personal knowledge management system</p>
            <button class="open-workspace-btn" onclick={openWorkspace}>
                Open Workspace
            </button>
        </div>
    {:else}
        <div class="workspace">
            <Sidebar onSelectFile={handleSelectFile} />
            <div class="main-content">
                {#if $viewMode === 'reading'}
                    <Reader />
                {:else}
                    <Index onSelectFile={handleSelectFile} />
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

    .welcome p {
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