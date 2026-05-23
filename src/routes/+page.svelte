<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { invoke } from "@tauri-apps/api/core";
    import { listen } from "@tauri-apps/api/event";
    import { appStore, isLoading, currentDocument, theme, syncStore, type SyncPeer } from "../lib/stores/app";
    import type { IndexData, Document, DocumentSummary, Theme } from "../lib/types";
    import Sidebar from "../lib/components/Sidebar.svelte";
    import Editor from "../lib/components/Editor.svelte";
    import SyncStatus from "../lib/components/SyncStatus.svelte";

    async function init() {
        appStore.setLoading(true);
        try {
            const indexData: IndexData = await invoke("get_all_documents");
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

            try {
                const deletedCount: number = await invoke("cleanup_orphaned_images");
                if (deletedCount > 0) {
                    console.log(`Cleaned up ${deletedCount} orphaned image(s)`);
                }
            } catch (e) {
                console.error("Failed to cleanup orphaned images:", e);
            }
        } catch (error) {
            console.error("Failed to initialize:", error);
        } finally {
            appStore.setLoading(false);
        }
    }

    let cleanupFns: Array<() => void> = [];

    onMount(async () => {
        try {
            const savedTheme: Theme = await invoke("get_theme");
            appStore.setTheme(savedTheme);
            document.body.dataset.theme = savedTheme;
        } catch (error) {
            console.error("Failed to load theme:", error);
            document.body.dataset.theme = "light";
        }

        try {
            const nodeId: string | null = await invoke("get_node_id");
            const peers: SyncPeer[] = await invoke("get_sync_peers");
            syncStore.setNodeId(nodeId || "");
            syncStore.setPeers(peers);
            syncStore.setEnabled(true);
            syncStore.setStatus("synced");
        } catch (e) {
            console.error("Failed to init sync:", e);
            syncStore.setStatus("offline");
        }

        const unlistenConnected = listen("peer-connected", (event) => {
            const peerNodeId = event.payload as string;
            syncStore.markPeerOnline(peerNodeId);
            syncStore.setStatus("synced");
        });
        const unlistenDisconnected = listen("peer-disconnected", () => {
            syncStore.setStatus("offline");
        });
        const unlistenSyncComplete = listen("sync-complete", () => {
            syncStore.setStatus("synced");
        });

        unlistenConnected.then(fn => cleanupFns.push(fn));
        unlistenDisconnected.then(fn => cleanupFns.push(fn));
        unlistenSyncComplete.then(fn => cleanupFns.push(fn));

        await init();
    });

    onDestroy(() => {
        cleanupFns.forEach(fn => fn());
    });

    $effect(() => {
        document.body.dataset.theme = $theme;
    });

    let activeDocument = $derived($currentDocument);
</script>

<main class="app">
    <div class="workspace">
        <Sidebar />
        <div class="main-content">
            <div class="sync-status-container">
                <SyncStatus />
            </div>
            {#if activeDocument}
                <Editor />
            {:else}
                <div class="empty-state">
                    <p>Loading...</p>
                </div>
            {/if}
        </div>
    </div>

    {#if $isLoading}
        <div class="loading-overlay">
            <div class="loading-spinner"></div>
            <p>Loading...</p>
        </div>
    {/if}
</main>

<style>
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