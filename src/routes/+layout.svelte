<script lang="ts">
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    import type { Snippet } from 'svelte';

    let { children }: { children: Snippet } = $props();

    let currentPath = $derived($page.url.pathname);

    function handleBack() {
        window.history.back();
    }

    function handleClose() {
        goto('/');
    }

    let pageTitle = $derived(() => {
        switch (currentPath) {
            case '/settings':
                return 'Settings';
            case '/settings/sync':
                return 'Sync';
            default:
                return '';
        }
    });

    let showHeader = $derived(currentPath !== '/');
    let canGoBack = $derived(currentPath !== '/settings');
</script>

{#if showHeader}
    <header class="app-header">
        {#if canGoBack}
            <button class="header-btn back-btn" onclick={handleBack} title="Back">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
            </button>
        {:else}
            <div class="header-spacer"></div>
        {/if}
        <h1 class="header-title">{pageTitle()}</h1>
        <button class="header-btn close-btn" onclick={handleClose} title="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
        </button>
    </header>
{/if}

{@render children()}

<style>
    .app-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 56px;
        padding: 0 16px;
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border-color);
        position: sticky;
        top: 0;
        z-index: 100;
    }

    .header-spacer {
        width: 40px;
    }

    .header-btn {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 8px;
        color: var(--text-primary);
        cursor: pointer;
        transition: background-color 0.15s;
    }

    .header-btn:hover {
        background: var(--bg-hover);
    }

    .header-title {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
    }
</style>