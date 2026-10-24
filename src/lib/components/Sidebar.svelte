<script lang="ts" module>
    // Tablets and phones start with the sidebar hidden so the editor gets the
    // full width; the » before the page's title brings it back.
    const SMALL_SCREEN_QUERY = '(max-width: 768px)';

    export function isSmallScreen(): boolean {
        return typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_QUERY).matches;
    }

    // Whether the sidebar was hidden the last time it was on a wide screen.
    // Every page has a sidebar of its own, made afresh when the page changes,
    // so this is kept here, where it outlives them. Hidden to have room to
    // write, the sidebar used to come back with the next page.
    let hiddenWhenWide = false;

    /**
     * Whether a page's sidebar starts out hidden: always on a small screen,
     * where it would cover the page, and on a wide one as it was left there.
     */
    export function startsCollapsed(): boolean {
        return isSmallScreen() || hiddenWhenWide;
    }
</script>

<script lang="ts">
    import { appStore, documents } from '../stores/app';
    import type { DocumentSummary } from '../types';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { setPinned } from '../services/documentActions';
    import { openJournal } from '../services/journals';
    import {
        openDocument,
        openHelp,
        openJournals,
        openNotes,
        openSearch,
        openTags,
        openTodos,
    } from '../services/navigation';
    import { page } from '$app/state';
    import { toasts } from '../services/toast';
    import NewNoteDialog from './NewNoteDialog.svelte';
    import RenameNoteDialog from './RenameNoteDialog.svelte';
    import DeleteNoteDialog from './DeleteNoteDialog.svelte';
    import DocumentList from './DocumentList.svelte';
    import SidebarSyncRow from './SidebarSyncRow.svelte';
    import Icon from './Icon.svelte';
    import JournalCalendar from './JournalCalendar.svelte';
    import { APP_VERSION } from '../version';
    import { customShortcuts } from '../keyboard/customShortcuts.svelte';
    import { indexRevision } from '../stores/derivedIndex';
    import { refreshTagCount, tagCount } from '../tags/tagCount';
    import { journalEntries } from '../journals/journalIndex';
    import { pinnedNotes } from '../notes/noteIndex';
    import { journalTitleFor } from '../calendar/calendar';

    interface Props {
        /**
         * Hidden. Bound by the workspace, whose header has the button that
         * brings the sidebar back.
         */
        collapsed: boolean;
    }

    let { collapsed = $bindable() }: Props = $props();

    // Navigate; the document route loads it. Fetching and assigning the store
    // here meant the URL never changed, so there was nothing to go back to.
    function handleDocClick(doc: DocumentSummary) {
        void openDocument(doc.id);
        dismissOnSmallScreen();
    }

    let showModal = $state(false);
    let small = $state(isSmallScreen());

    // Follow the viewport rather than sampling it once at startup. Rotating a
    // tablet or resizing a window left the sidebar in whatever state it had
    // been in when the app opened. Becoming small puts it out of the way;
    // becoming wide keeps it open if it was, and otherwise brings it back as
    // it was last left on a wide screen.
    $effect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia(SMALL_SCREEN_QUERY);
        const onChange = (e: MediaQueryListEvent) => {
            small = e.matches;
            collapsed = e.matches || (collapsed && hiddenWhenWide);
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    // On a wide screen, the next page's sidebar starts as this one is now.
    // Only there: on a small screen every page starts with it hidden.
    $effect(() => {
        if (!small) hiddenWhenWide = collapsed;
    });

    // On a phone the sidebar covers the editor rather than sitting beside it,
    // so picking something has to get it out of the way. Expanded, it left
    // about 125px of a 375px screen to write in.
    function dismissOnSmallScreen() {
        if (small) collapsed = true;
    }

    // Recomputed rather than read from `new Date()` at render time, so an app
    // left open overnight stops calling yesterday "today".
    let today = $state(new Date());

    $effect(() => {
        const refresh = () => {
            const now = new Date();
            if (now.toDateString() !== today.toDateString()) today = now;
        };
        // A minute is close enough to midnight, and cheaper to reason about
        // than a timer that has to reschedule itself. The visibility check
        // covers a device that was asleep across the boundary.
        const timer = setInterval(refresh, 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    });

    // Everything still to do, across every note and journal. The counts are
    // already kept current in the document store by the save and merge paths,
    // so the badge costs no query of its own.
    let openTodoCount = $derived(
        $documents.reduce(
            (n: number, d: DocumentSummary) => n + (d.todo_count - d.completed_todo_count),
            0,
        ),
    );
    let onSearchPage = $derived(page.url.pathname === '/search');
    let onTodosPage = $derived(page.url.pathname === '/todos');
    let onJournalsPage = $derived(page.url.pathname === '/journals');
    let onNotesPage = $derived(page.url.pathname === '/notes');
    // Both the index and any one tag's page, so the item stays lit while the
    // user is reading a tag rather than only on the list itself.
    let onTagsPage = $derived(page.url.pathname.startsWith('/tags'));
    let onHelpPage = $derived(page.url.pathname === '/help');

    // Unlike the todo badge above, this cannot be derived from what is already
    // in memory: a tag belongs to no single document, so nothing in the
    // document store knows about one. Asked again on every change to any
    // document's derived rows, which is what a tag being added, renamed or
    // removed is, here or on another device.
    $effect(() => {
        void $indexRevision;
        void refreshTagCount();
    });

    // The search box at the top. It opens the Search page, which finds
    // notes, journals, todos and tags by their words.
    function goToSwitcher() {
        void openSearch();
        dismissOnSmallScreen();
    }

    let switcherKeys = $derived(customShortcuts.labelFor('search'));

    // Today, first among the places: the journal Oyot opens on.
    let todayTitle = $derived(journalTitleFor(today));
    let todayShort = $derived(
        `${today.toLocaleDateString(undefined, { weekday: 'short' })} ${today.getDate()}`,
    );

    function goToToday() {
        void openJournalFor(todayTitle);
    }

    function goToNotes() {
        void openNotes();
        dismissOnSmallScreen();
    }

    function goToJournals() {
        void openJournals();
        dismissOnSmallScreen();
    }

    function goToTodos() {
        void openTodos();
        dismissOnSmallScreen();
    }

    function goToTags() {
        void openTags();
        dismissOnSmallScreen();
    }

    function goToHelp() {
        void openHelp();
        dismissOnSmallScreen();
    }

    // A button's tooltip, naming the keys that do the same from anywhere,
    // the way the Edit button names its own. The keys in use, which the user
    // may have changed, or left it without.
    function withKeys(label: string, id: string): string {
        const keys = customShortcuts.labelFor(id);
        return keys ? `${label} (${keys})` : label;
    }

    // The document on screen, which is not always the store's open document.
    // The store keeps the last one after the user leaves it for an index
    // page, so coming back to it needs no second load. Taken from the store
    // alone, the calendar went on outlining that journal's day, or the pinned
    // list lighting that note, on the Notes or Todos page, with no document
    // on screen at all.
    let shownDocument = $derived(page.route.id === '/doc/[id]' ? $appStore.currentDocument : null);
    let currentDocId = $derived(shownDocument?.id);
    let currentJournalTitle = $derived(
        shownDocument?.doc_type === 'journal' ? shownDocument.title : null,
    );
    let onTodaysJournal = $derived(currentJournalTitle === todayTitle);
    let journals = $derived($documents.filter((d: DocumentSummary) => d.doc_type === 'journal'));
    // What the journal index will list, which is not quite every journal row:
    // one whose title is not a date has no day to be listed under. Counted the
    // same way here so the badge and the page cannot disagree.
    let journalDayCount = $derived(journalEntries($documents).length);
    // Only the notes the user pinned are listed here, in the order the Notes
    // index uses; every note is one click away there, and its count is on
    // the Index entry below.
    let pinned = $derived(pinnedNotes($documents));
    let noteCount = $derived(
        $documents.filter((d: DocumentSummary) => d.doc_type === 'note').length,
    );

    let openMenuId = $state<string | null>(null);
    let renameDoc = $state<DocumentSummary | null>(null);
    let deleteDoc = $state<DocumentSummary | null>(null);

    function toggleMenu(e: MouseEvent, docId: string) {
        e.stopPropagation();
        openMenuId = openMenuId === docId ? null : docId;
    }

    function handleWindowClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (!target.closest('.doc-menu-btn') && !target.closest('.doc-menu')) {
            openMenuId = null;
        }
    }

    function startRename(doc: DocumentSummary) {
        renameDoc = doc;
        openMenuId = null;
    }

    function startDelete(doc: DocumentSummary) {
        deleteDoc = doc;
        openMenuId = null;
    }

    async function togglePin(doc: DocumentSummary) {
        openMenuId = null;
        try {
            await setPinned(doc.id, !doc.pinned);
        } catch (err) {
            console.error('[Sidebar] Failed to change the pin:', err);
            toasts.error(doc.pinned ? 'Could not unpin this note' : 'Could not pin this note');
        }
    }

    function goToSettings() {
        goto(resolve('/settings'));
    }

    function goToAbout() {
        goto(resolve('/settings/about'));
        dismissOnSmallScreen();
    }

    // A day picked in the calendar. Opening it, and starting its journal if
    // it has none, is shared with the keys for today and the days either
    // side, in $lib/services/journals.
    async function openJournalFor(journalTitle: string) {
        try {
            await openJournal(journalTitle);
            dismissOnSmallScreen();
        } catch (err) {
            console.error('[Sidebar] Failed to open the journal for', journalTitle, err);
            toasts.error('Could not open that day');
        }
    }
</script>

<svelte:window onclick={handleWindowClick} />

<!-- Shown and hidden by the button before the page's title, in the
     workspace's header. On a phone it is a drawer over the page. -->
<aside id="sidebar" class="sidebar" class:collapsed class:overlay={small && !collapsed}>
    {#if !collapsed}
        <div class="sidebar-top">
            <span class="logo" aria-hidden="true"><span class="logo-o"></span></span>
            <span class="wordmark">Oyot</span>
            <span class="grow"></span>
            <button
                class="icon-btn"
                onclick={() => (showModal = true)}
                title="New note"
                aria-label="New note"
            >
                <Icon name="compose" />
            </button>
            {#if !small}
                <button
                    class="icon-btn"
                    onclick={() => (collapsed = true)}
                    title={withKeys('Hide sidebar', 'sidebar')}
                    aria-label="Hide sidebar"
                >
                    <Icon name="panel-left" />
                </button>
            {/if}
        </div>

        <!-- First, since it is the way into all the rest: it finds notes and
             journals by their words, and todos and tags as well. -->
        <button
            class="search-btn"
            class:active={onSearchPage}
            onclick={goToSwitcher}
            title={withKeys('Search', 'search')}
        >
            <Icon name="search" size={16} />
            <span class="grow">Search or jump to</span>
            {#if switcherKeys}
                <span class="kbd">{switcherKeys}</span>
            {/if}
        </button>

        <div class="sidebar-content">
            <nav class="nav" aria-label="Places">
                <button
                    class="nav-item"
                    class:active={onTodaysJournal}
                    aria-current={onTodaysJournal ? 'page' : undefined}
                    onclick={goToToday}
                    title={withKeys("Today's journal", 'today')}
                >
                    <Icon name="today" />
                    <span class="nav-label">Today</span>
                    <span class="nav-count">{todayShort}</span>
                </button>
                <!-- The calendar below shows one month; this is the whole run
                     of them, which is the only way to see how far back the
                     journal goes. -->
                <button
                    class="nav-item"
                    class:active={onJournalsPage}
                    aria-current={onJournalsPage ? 'page' : undefined}
                    onclick={goToJournals}
                    title={withKeys('Journals', 'journals')}
                >
                    <Icon name="journals" />
                    <span class="nav-label">Journals</span>
                    {#if journalDayCount > 0}
                        <span class="nav-count">{journalDayCount}</span>
                    {/if}
                </button>
                <button
                    class="nav-item"
                    class:active={onNotesPage}
                    aria-current={onNotesPage ? 'page' : undefined}
                    onclick={goToNotes}
                    title={withKeys('Notes', 'notes')}
                >
                    <Icon name="notes" />
                    <span class="nav-label">Notes</span>
                    {#if noteCount > 0}
                        <span class="nav-count">{noteCount}</span>
                    {/if}
                </button>
                <button
                    class="nav-item"
                    class:active={onTodosPage}
                    aria-current={onTodosPage ? 'page' : undefined}
                    onclick={goToTodos}
                    title={withKeys('Todos', 'todos')}
                >
                    <Icon name="todos" />
                    <span class="nav-label">Todos</span>
                    {#if openTodoCount > 0}
                        <span class="nav-count">{openTodoCount}</span>
                    {/if}
                </button>
                <button
                    class="nav-item"
                    class:active={onTagsPage}
                    aria-current={onTagsPage ? 'page' : undefined}
                    onclick={goToTags}
                    title={withKeys('Tags', 'tags')}
                >
                    <Icon name="tags" />
                    <span class="nav-label">Tags</span>
                    {#if $tagCount > 0}
                        <span class="nav-count">{$tagCount}</span>
                    {/if}
                </button>
            </nav>

            <!-- The calendar, with no heading over it. It is how a journal is
                 found: a journal is named for its day, so a month grid
                 marking the days with something written in them beats a
                 column of dates, and it says what it is without being told. -->
            <div class="sidebar-section">
                <JournalCalendar {journals} {currentJournalTitle} {today} onPick={openJournalFor} />
            </div>

            <div class="sidebar-section">
                <h3>
                    Pinned
                    <button
                        class="icon-btn small"
                        onclick={() => (showModal = true)}
                        title="New note"
                        aria-label="New pinned note"><Icon name="plus" size={16} /></button
                    >
                </h3>
                {#if pinned.length > 0}
                    <DocumentList
                        documents={pinned}
                        {currentDocId}
                        {openMenuId}
                        onOpen={handleDocClick}
                        onToggleMenu={toggleMenu}
                        onRename={startRename}
                        onDelete={startDelete}
                        onTogglePin={togglePin}
                    />
                {:else}
                    <!-- Where everyone starts after updating, since no note
                         was pinned before pins existed. It has to say where
                         the notes that used to be listed here went. -->
                    <p class="pinned-empty">
                        Pin a note to keep it here. All your notes are in
                        <button class="pinned-empty-link" onclick={goToNotes}>Notes</button>.
                    </p>
                {/if}
            </div>
        </div>

        <div class="sidebar-footer">
            <SidebarSyncRow onNavigate={dismissOnSmallScreen} />
            <div class="footer-tools">
                <!-- Lit while open, like the places above: the help page
                     keeps the sidebar, so this is on screen with it. -->
                <button
                    class="icon-btn"
                    class:active={onHelpPage}
                    onclick={goToHelp}
                    title={withKeys('Help and keyboard shortcuts', 'help')}
                    aria-label="Help"
                    aria-current={onHelpPage ? 'page' : undefined}
                >
                    <Icon name="help" />
                </button>
                <!-- Named by aria-label, as Help is, so the keys in the
                     tooltip are not read out as part of its name. -->
                <button
                    class="icon-btn"
                    onclick={goToSettings}
                    title={withKeys('Settings', 'settings')}
                    aria-label="Settings"
                >
                    <Icon name="settings" />
                </button>
                <button class="version-btn" onclick={goToAbout} title="About Oyot and what's new">
                    v{APP_VERSION}
                </button>
            </div>
        </div>
    {/if}
</aside>

{#if small && !collapsed}
    <!-- Tapping away closes it. -->
    <div class="sidebar-scrim" role="presentation" onclick={() => (collapsed = true)}></div>
{/if}

{#if showModal}
    <!-- Started from the pinned list, so it starts pinned: what is added
         to a list lands in it. The dialog shows the choice, and it can be
         unticked. -->
    <NewNoteDialog pinned onClose={() => (showModal = false)} />
{/if}

{#if renameDoc}
    <RenameNoteDialog doc={renameDoc} onClose={() => (renameDoc = null)} />
{/if}

{#if deleteDoc}
    <DeleteNoteDialog doc={deleteDoc} onClose={() => (deleteDoc = null)} />
{/if}

<style>
    .sidebar {
        width: 264px;
        min-width: 264px;
        height: 100%;
        display: flex;
        flex-direction: column;
        padding: 10px 10px 10px 12px;
        overflow: hidden;
        background: var(--bg-secondary);
    }

    .sidebar.collapsed {
        display: none;
    }

    /* A drawer over the page on a phone, the same sidebar the desktop has,
       sliding in from the left edge. */
    .sidebar.overlay {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        width: min(320px, 86vw);
        padding: calc(var(--safe-top) + 12px) 12px calc(var(--safe-bottom) + 12px)
            calc(var(--safe-left) + 14px);
        z-index: 120;
        border-radius: 0 var(--radius-xl) var(--radius-xl) 0;
        box-shadow: var(--shadow-pop);
        animation: slide-in 0.2s ease-out;
    }

    @keyframes slide-in {
        from {
            transform: translateX(-100%);
        }
        to {
            transform: translateX(0);
        }
    }

    .sidebar-scrim {
        position: fixed;
        inset: 0;
        z-index: 110;
        background: var(--scrim);
    }

    .sidebar-top {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        padding: 0 2px 0 6px;
        margin-bottom: 8px;
        flex-shrink: 0;
    }

    .logo {
        width: 24px;
        height: 24px;
        border-radius: 7px;
        background: var(--accent-color);
        display: grid;
        place-items: center;
        flex-shrink: 0;
    }

    .logo-o {
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 2.5px solid var(--bg-primary);
    }

    .wordmark {
        font-weight: 650;
        font-size: 15px;
        letter-spacing: -0.015em;
    }

    .grow {
        flex: 1;
        min-width: 0;
    }

    .icon-btn {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .icon-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .icon-btn.active {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .icon-btn.small {
        width: 26px;
        height: 26px;
        border-radius: 7px;
    }

    .search-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: 36px;
        padding: 0 6px 0 10px;
        border: none;
        border-radius: 9px;
        background: var(--bg-primary);
        box-shadow: 0 0 0 1px var(--border-color);
        color: var(--text-muted);
        font-size: 13.5px;
        text-align: left;
        cursor: pointer;
    }

    .search-btn:hover,
    .search-btn.active {
        color: var(--text-primary);
        box-shadow: var(--shadow-sheet);
    }

    .sidebar-content {
        flex: 1;
        overflow-y: auto;
        margin: 0 -4px;
        padding: 0 4px;
    }

    .nav {
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-top: 10px;
    }

    .nav-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 34px;
        padding: 0 10px;
        border: none;
        border-radius: var(--radius-md);
        background: transparent;
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
    }

    .nav-item:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* The current place is a piece of the sheet, lifted out of the frame. */
    .nav-item.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sheet);
    }

    .nav-item.active :global(.icon) {
        color: var(--accent-color);
    }

    .nav-label {
        flex: 1;
        min-width: 0;
    }

    .nav-count {
        flex-shrink: 0;
        font-size: 12px;
        font-weight: 450;
        font-variant-numeric: tabular-nums;
        color: var(--text-muted);
    }

    .sidebar-section {
        padding: 14px 0 0;
    }

    .sidebar-section h3 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 30px;
        margin: 0;
        padding: 0 4px 0 10px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
    }

    .pinned-empty {
        margin: 0;
        padding: 4px 10px;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--text-muted);
    }

    .pinned-empty-link {
        padding: 0;
        border: none;
        background: none;
        color: var(--accent-color);
        font: inherit;
        cursor: pointer;
    }

    .pinned-empty-link:hover {
        text-decoration: underline;
    }

    .sidebar-footer {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 8px;
        border-top: 1px solid var(--border-color);
    }

    .footer-tools {
        display: flex;
        align-items: center;
        gap: 2px;
        padding-left: 2px;
    }

    .version-btn {
        margin-left: auto;
        padding: 4px 8px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-muted);
        font-size: 11.5px;
        cursor: pointer;
    }

    .version-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* A finger needs more room than a pointer. */
    @media (pointer: coarse) {
        .nav-item {
            height: 42px;
            font-size: 15px;
        }

        .search-btn {
            height: 42px;
        }

        .icon-btn {
            width: 40px;
            height: 40px;
        }
    }
</style>
