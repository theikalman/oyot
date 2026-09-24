<script lang="ts">
    import type { Snippet } from 'svelte';
    import { isLoading } from '$lib/stores/app';
    import Sidebar from './Sidebar.svelte';
    import SyncStatus from './SyncStatus.svelte';

    // The chrome every workspace route shares: the sidebar beside a titled
    // column with the sync indicator in its header. Extracted when the todo
    // index became the second route to need exactly this, rather than copied
    // and left to drift.
    interface Props {
        title?: string | null;
        /** Controls that belong to the title, such as pinning the open note. */
        actions?: Snippet;
        /** Controls for the page as a whole, beside the sync indicator. */
        tools?: Snippet;
        children: Snippet;
    }

    let { title = null, actions, tools, children }: Props = $props();
</script>

<main class="app">
    <div class="workspace">
        <Sidebar />
        <div class="main-content">
            <div class="sync-status-container">
                {#if title}
                    <div class="page-heading">
                        <h1 class="page-title">{title}</h1>
                        {@render actions?.()}
                    </div>
                {/if}
                <div class="page-tools">
                    {@render tools?.()}
                    <SyncStatus />
                </div>
            </div>
            {@render children()}
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
        /* The body's safe-area padding already takes this much of the screen. */
        height: calc(100dvh - var(--safe-top) - var(--safe-bottom));
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

    .page-heading {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }

    .page-title {
        margin: 0;
        font-size: 24px;
        color: var(--text-primary);
    }

    .page-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
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
