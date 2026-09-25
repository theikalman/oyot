<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import type { Snippet } from 'svelte';
    import { initSync, shutdownSync } from '$lib/sync';
    import { appStore } from '$lib/stores/app';
    import { applyTheme } from '$lib/services/theme';
    import { startApp } from '$lib/services/startup';
    import { watchScheduledBackups } from '$lib/backup';
    import { isHelpShortcut } from '$lib/help/helpShortcut';
    import { openHelp } from '$lib/services/navigation';
    import ToastContainer from '$lib/components/ToastContainer.svelte';
    import '../app.css';

    let { children }: { children: Snippet } = $props();

    // Started here, not on a page. The layout is the only thing mounted for
    // the app's lifetime: when startup lived on the workspace page, every trip
    // to settings and back tore that page down and re-ran all of it, which
    // reloaded the document list, re-announced today's journal to every peer,
    // flashed the loading overlay, and put the user back on the journal
    // instead of the note they had been reading.
    let stopWatchingBackups: (() => void) | null = null;

    onMount(() => {
        initSync();
        void startApp();
        // Here for the same reason: a failing backup schedule should be
        // heard of wherever the user is, not only on the settings page.
        stopWatchingBackups = watchScheduledBackups();
    });

    onDestroy(() => {
        shutdownSync();
        stopWatchingBackups?.();
    });

    // Every route, so the toggle on the settings page has a visible effect.
    // It used to be applied only by the workspace page, so switching theme in
    // settings did nothing until the user navigated back.
    $effect(() => {
        applyTheme($appStore.theme);
    });

    let currentPath = $derived(page.url.pathname);

    function handleBack() {
        window.history.back();
    }

    function handleClose() {
        goto(resolve('/'));
    }

    // The help page's shortcut, taken here because this layout is on screen
    // whatever the route, settings included. Not while a dialog is open: it
    // is something half done, and leaving the page would throw it away.
    function handleKeydown(event: KeyboardEvent) {
        if (!isHelpShortcut(event)) return;
        event.preventDefault();
        if (document.querySelector('[aria-modal="true"]')) return;
        if (currentPath !== '/help') void openHelp();
    }

    let pageTitle = $derived.by(() => {
        switch (currentPath) {
            case '/settings':
                return 'Settings';
            case '/settings/sync':
                return 'Sync';
            case '/settings/backup':
                return 'Backup';
            default:
                return '';
        }
    });

    // The header belongs to the settings routes. The workspace has its own.
    let showHeader = $derived(currentPath.startsWith('/settings'));
    let canGoBack = $derived(currentPath !== '/settings');
</script>

<svelte:window onkeydown={handleKeydown} />

{#if showHeader}
    <header class="app-header">
        {#if canGoBack}
            <button class="header-btn back-btn" onclick={handleBack} title="Back">
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
            </button>
        {:else}
            <div class="header-spacer"></div>
        {/if}
        <h1 class="header-title">{pageTitle}</h1>
        <button class="header-btn close-btn" onclick={handleClose} title="Close">
            <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <path d="M18 6L6 18M6 6l12 12" />
            </svg>
        </button>
    </header>
{/if}

{@render children()}

<ToastContainer />

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
        top: var(--safe-top);
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
