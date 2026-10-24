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
    import { watchMcpRequests } from '$lib/mcp/relay';
    import ToastContainer from '$lib/components/ToastContainer.svelte';
    import CloseNoticeDialog from '$lib/components/CloseNoticeDialog.svelte';
    import { rememberWorkspacePath } from '$lib/components/SettingsShell.svelte';
    import '../app.css';

    let { children }: { children: Snippet } = $props();

    // Started here, not on a page. The layout is the only thing mounted for
    // the app's lifetime: when startup lived on the workspace page, every trip
    // to settings and back tore that page down and re-ran all of it, which
    // reloaded the document list, re-announced today's journal to every peer,
    // flashed the loading overlay, and put the user back on the journal
    // instead of the note they had been reading.
    let stopWatchingBackups: (() => void) | null = null;
    let stopWatchingMcp: (() => void) | null = null;
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
        // An assistant reading a note, over MCP (ADR 0037). Rust asks the
        // page to render it, on whatever route the user is.
        stopWatchingMcp = watchMcpRequests();
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
        stopWatchingMcp?.();
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
    // leaving the page would throw it away. On the page it opens, a
    // shortcut does nothing here, and the Search page answers its own.
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

    // Back and Esc in Settings return to where the user was before it.
    $effect(() => {
        rememberWorkspacePath(currentPath);
    });
</script>

<svelte:window onkeydown={handleKeydown} />

{@render children()}

<ToastContainer />

{#if answerCloseNotice}
    <CloseNoticeDialog onAnswer={answerCloseNotice} />
{/if}
