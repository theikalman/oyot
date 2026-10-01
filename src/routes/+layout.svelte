<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import type { Snippet } from 'svelte';
    import { initSync, shutdownSync, refreshSyncStatus } from '$lib/sync';
    import { appStore, documents } from '$lib/stores/app';
    import { applyTheme } from '$lib/services/theme';
    import { openJournal } from '$lib/services/journals';
    import { toasts } from '$lib/services/toast';
    import { startApp } from '$lib/services/startup';
    import { catchUpIndex } from '$lib/services/documents';
    import { watchScheduledBackups } from '$lib/backup';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { GO_TO_SHORTCUTS, destination } from '$lib/keyboard/goTo';
    import { watchCloseRequests } from '$lib/desktop';
    import ToastContainer from '$lib/components/ToastContainer.svelte';
    import CloseNoticeDialog from '$lib/components/CloseNoticeDialog.svelte';
    import '../app.css';

    let { children }: { children: Snippet } = $props();

    // Started here, not on a page. The layout is the only thing mounted for
    // the app's lifetime: when startup lived on the workspace page, every trip
    // to settings and back tore that page down and re-ran all of it, which
    // reloaded the document list, re-announced today's journal to every peer,
    // flashed the loading overlay, and put the user back on the journal
    // instead of the note they had been reading.
    let stopWatchingBackups: (() => void) | null = null;
    let stopWatchingCloses: (() => void) | null = null;

    // Set while the first-close notice is up: the function its buttons answer
    // with.
    let answerCloseNotice = $state<((keepRunning: boolean) => void) | null>(null);

    // Sync carries on while the page is away (ADR 0031): catch up with it.
    function handleVisibilityChange() {
        if (document.visibilityState !== 'visible') return;
        void catchUpIndex();
        void refreshSyncStatus().catch((e) => console.warn('[sync] could not read status:', e));
    }

    onMount(() => {
        initSync();
        void startApp();
        document.addEventListener('visibilitychange', handleVisibilityChange);
        // Here for the same reason: a failing backup schedule should be
        // heard of wherever the user is, not only on the settings page.
        stopWatchingBackups = watchScheduledBackups();
        // And closing the window, which has to save the open note whatever
        // page it is on (ADR 0030, decision 5). Only a desktop sends these.
        stopWatchingCloses = watchCloseRequests(
            () =>
                new Promise<boolean>((resolve) => {
                    answerCloseNotice = (keepRunning) => {
                        answerCloseNotice = null;
                        resolve(keepRunning);
                    };
                }),
        );
    });

    onDestroy(() => {
        shutdownSync();
        stopWatchingBackups?.();
        stopWatchingCloses?.();
        document.removeEventListener('visibilitychange', handleVisibilityChange);
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

    // The journal on screen, by the URL, which names it before it has
    // loaded. Its day is its title.
    let openJournalTitle = $derived.by(() => {
        if (page.route.id !== '/doc/[id]') return null;
        const doc = $documents.find((d) => d.id === page.params.id);
        return doc?.doc_type === 'journal' ? doc.title : null;
    });

    // The day the keys are on their way to, until it is open. A second
    // press before then counts on from it, so two quick presses are two
    // days, even when the first has a journal to start.
    let journalOnItsWay: string | null = null;

    async function openDay(title: string) {
        journalOnItsWay = title;
        try {
            await openJournal(title);
        } catch (error) {
            console.error('[shortcuts] could not open the journal for', title, error);
            toasts.error('Could not open that day');
        } finally {
            if (journalOnItsWay === title) journalOnItsWay = null;
        }
    }

    // The shortcuts that go somewhere: Help, the pages under Index,
    // Settings, and the journals for today and the days either side. Taken
    // here because this layout is on screen whatever the route, settings
    // included. Not while a dialog is open: it is something half done, and
    // leaving the page would throw it away.
    function handleKeydown(event: KeyboardEvent) {
        const id = GO_TO_SHORTCUTS.find((id) => customShortcuts.matches(id, event));
        if (id === undefined) return;
        event.preventDefault();
        // Held down, the keys go once. A repeat that came before the page
        // had opened would open it again, a second step back to undo, and
        // one stepping through days would start a journal for each.
        if (event.repeat || document.querySelector('[aria-modal="true"]')) return;
        const here = { path: currentPath, journal: journalOnItsWay ?? openJournalTitle };
        const to = destination(id, here, new Date());
        if (to === null) return;
        if (to.kind === 'page') void goto(resolve(to.path));
        else void openDay(to.title);
    }

    let pageTitle = $derived.by(() => {
        switch (currentPath) {
            case '/settings':
                return 'Settings';
            case '/settings/sync':
                return 'Sync';
            case '/settings/backup':
                return 'Backup';
            case '/settings/shortcuts':
                return 'Keyboard shortcuts';
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

{#if answerCloseNotice}
    <CloseNoticeDialog onAnswer={answerCloseNotice} />
{/if}

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
