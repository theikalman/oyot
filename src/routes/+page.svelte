<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { appStore, isLoading, currentDocument } from '$lib/stores/app';
    import { initializeTheme, applyTheme } from '$lib/services/theme';
    import { initializeSync, getSyncCleanup } from '$lib/services/sync';
    import { loadAllDocuments, getOrCreateTodayJournal, cleanupOrphanedImages, toDocumentSummary } from '$lib/services/documents';
    import Sidebar from '$lib/components/Sidebar.svelte';
    import Editor from '$lib/editor/Editor.svelte';
    import SyncStatus from '$lib/components/SyncStatus.svelte';
    import ToastContainer from '$lib/components/ToastContainer.svelte';

    let activeDocument = $derived($currentDocument);

    async function init() {
        appStore.setLoading(true);
        try {
            const indexData = await loadAllDocuments();
            appStore.setDocuments(indexData.documents);

            const todayJournal = await getOrCreateTodayJournal();
            const summary = toDocumentSummary(todayJournal);
            appStore.addDocument(summary);
            appStore.setCurrentDocument(todayJournal);

            await cleanupOrphanedImages();
        } catch (error) {
            console.error('Failed to initialize:', error);
        } finally {
            appStore.setLoading(false);
        }
    }

    onMount(async () => {
        try {
            const savedTheme = await initializeTheme();
            appStore.setTheme(savedTheme);
        } catch (error) {
            console.error('Failed to load theme:', error);
        }

        try {
            await initializeSync();
        } catch (error) {
            console.error('Failed to init sync:', error);
        }

        await init();
    });

    onDestroy(() => {
        const cleanup = getSyncCleanup();
        cleanup();
    });

    $effect(() => {
        const theme = $appStore.theme;
        applyTheme(theme);
    });
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

    <ToastContainer />
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
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color);
        min-height: 57px;
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