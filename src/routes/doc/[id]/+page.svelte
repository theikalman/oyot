<script lang="ts">
    import { page } from '$app/state';
    import { currentDocument, appStore, isLoading } from '$lib/stores/app';
    import { loadDocument } from '$lib/services/documents';
    import Sidebar from '$lib/components/Sidebar.svelte';
    import Editor from '$lib/editor/Editor.svelte';
    import SyncStatus from '$lib/components/SyncStatus.svelte';

    let activeDocument = $derived($currentDocument);

    // The URL is what says which document is open, so opening one is a
    // navigation and the back button works. Before this the only record was a
    // store, so there were no deep links, no history, and Android's hardware
    // back key exited the app from the only route there was.
    let routeId = $derived(page.params.id);
    let loadFailed = $state(false);

    $effect(() => {
        const id = routeId;
        if (!id || id === $currentDocument?.id) return;

        let cancelled = false;
        loadFailed = false;
        void loadDocument(id)
            .then((doc) => {
                if (!cancelled) appStore.setCurrentDocument(doc);
            })
            .catch(() => {
                // loadDocument has already reported it. A bad id in the URL
                // is a dead end rather than an error state to recover from.
                if (!cancelled) loadFailed = true;
            });

        // A quick switch must not let the slower load win and show the
        // document the user has already navigated away from.
        return () => {
            cancelled = true;
        };
    });
</script>

<main class="app">
    <div class="workspace">
        <Sidebar />
        <div class="main-content">
            <div class="sync-status-container">
                {#if activeDocument}
                    <h1 class="page-title">{activeDocument.title}</h1>
                {/if}
                <SyncStatus />
            </div>
            {#if activeDocument}
                <Editor />
            {:else if loadFailed}
                <div class="empty-state">
                    <p>That note no longer exists.</p>
                </div>
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
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color);
        min-height: 57px;
    }

    .page-title {
        margin: 0;
        font-size: 24px;
        color: var(--text-primary);
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
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .loading-overlay p {
        margin-top: 16px;
        color: var(--text-secondary);
    }
</style>
