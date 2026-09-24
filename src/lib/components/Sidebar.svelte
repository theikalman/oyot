<script lang="ts">
    import { appStore, documents } from '../stores/app';
    import type { DocumentSummary } from '../types';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { createJournalForDate as createJournalForDateAction } from '../services/documentActions';
    import { openDocument, openJournals, openTags, openTodos } from '../services/navigation';
    import { page } from '$app/state';
    import { toasts } from '../services/toast';
    import { snippetParts } from '../search/snippet';
    import { createSearch, type SearchHit } from '../search/searchStore.svelte';
    import AboutDialog from './AboutDialog.svelte';
    import NewNoteDialog from './NewNoteDialog.svelte';
    import RenameNoteDialog from './RenameNoteDialog.svelte';
    import DeleteNoteDialog from './DeleteNoteDialog.svelte';
    import DocumentList from './DocumentList.svelte';
    import SidebarDeviceList from './SidebarDeviceList.svelte';
    import JournalCalendar from './JournalCalendar.svelte';
    import { APP_VERSION } from '../version';
    import { indexRevision } from '../stores/derivedIndex';
    import { refreshTagCount, tagCount } from '../tags/tagCount';
    import { journalEntries } from '../journals/journalIndex';

    // Navigate; the document route loads it. Fetching and assigning the store
    // here meant the URL never changed, so there was nothing to go back to.
    function handleDocClick(doc: DocumentSummary) {
        void openDocument(doc.id);
        dismissOnSmallScreen();
    }

    let searchInput = $state('');
    let showModal = $state(false);
    // Tablets and phones start with the sidebar hidden so the editor gets the full
    // width; the floating toggle button is still there to bring it back.
    const SMALL_SCREEN_QUERY = '(max-width: 768px)';

    function isSmallScreen(): boolean {
        return typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_QUERY).matches;
    }

    let collapsed = $state(isSmallScreen());
    let small = $state(isSmallScreen());

    // Follow the viewport rather than sampling it once at startup. Rotating a
    // tablet or resizing a window left the sidebar in whatever state it had
    // been in when the app opened.
    $effect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia(SMALL_SCREEN_QUERY);
        const onChange = (e: MediaQueryListEvent) => {
            small = e.matches;
            collapsed = e.matches;
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
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
    let onTodosPage = $derived(page.url.pathname === '/todos');
    let onJournalsPage = $derived(page.url.pathname === '/journals');
    // Both the index and any one tag's page, so the item stays lit while the
    // user is reading a tag rather than only on the list itself.
    let onTagsPage = $derived(page.url.pathname.startsWith('/tags'));

    // Unlike the todo badge above, this cannot be derived from what is already
    // in memory: a tag belongs to no single document, so nothing in the
    // document store knows about one. Asked again on every change to any
    // document's derived rows, which is what a tag being added, renamed or
    // removed is, here or on another device.
    $effect(() => {
        void $indexRevision;
        void refreshTagCount();
    });

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

    let currentDocId = $derived($appStore.currentDocument?.id);
    let currentJournalTitle = $derived(
        $appStore.currentDocument?.doc_type === 'journal' ? $appStore.currentDocument.title : null,
    );
    let journals = $derived($documents.filter((d: DocumentSummary) => d.doc_type === 'journal'));
    // What the journal index will list, which is not quite every journal row:
    // one whose title is not a date has no day to be listed under. Counted the
    // same way here so the badge and the page cannot disagree.
    let journalDayCount = $derived(journalEntries($documents).length);
    let notes = $derived($documents.filter((d: DocumentSummary) => d.doc_type === 'note'));

    // Search runs in SQL over an FTS index of titles and bodies, so it finds
    // what the user wrote, not just what they named it, and covers journals as
    // well as notes. The debounce, the sequencing and the selection live in
    // $lib/search: three pieces of state that have to stay in step, which they
    // did not reliably do as loose variables among everything else here.
    const search = createSearch();

    let isSearchActive = $derived(searchInput.trim().length > 0);

    $effect(() => search.schedule(searchInput.trim()));

    // Arrow keys move through the results and Enter opens one, so a search can
    // be completed without leaving the keyboard. Escape clears the box, which
    // is also how you get back to the document list.
    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            searchInput = '';
            return;
        }
        if (search.results.length === 0) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            search.move(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            search.move(-1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const hit = search.current();
            if (hit) openSearchHit(hit);
        }
    }

    function openSearchHit(hit: SearchHit) {
        void openDocument(hit.id);
        dismissOnSmallScreen();
    }

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

    let showAbout = $state(false);

    function goToSettings() {
        goto(resolve('/settings'));
    }

    function goToSync() {
        goto(resolve('/settings/sync'));
    }

    // One way in for "open the journal for this date", used by the calendar.
    // The date arithmetic moved to $lib/calendar; what stays here is the part
    // that needs the document list and the router.
    async function openJournalFor(journalTitle: string) {
        const existing = journals.find((d: DocumentSummary) => d.title === journalTitle);
        if (existing) {
            handleDocClick(existing);
            return;
        }
        try {
            const doc = await createJournalForDateAction(journalTitle);
            await openDocument(doc.id);
            dismissOnSmallScreen();
        } catch (err) {
            console.error('[Sidebar] Failed to create journal for date:', journalTitle, err);
            toasts.error('Could not open that day');
        }
    }
</script>

<svelte:window onclick={handleWindowClick} />

<aside class="sidebar" class:collapsed class:overlay={small && !collapsed}>
    <div class="sidebar-header">
        {#if !collapsed}
            <input
                type="text"
                placeholder="Search documents..."
                bind:value={searchInput}
                onkeydown={handleSearchKeydown}
                class="search-input"
                aria-label="Search documents"
            />
            <button class="collapse-btn" onclick={() => (collapsed = true)} title="Collapse">
                <svg
                    width="20"
                    height="20"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    ><path
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="m11 17-5-5 5-5M18 17l-5-5 5-5"
                    /></svg
                >
            </button>
        {/if}
    </div>

    {#if !collapsed}
        <div class="sidebar-content">
            {#if isSearchActive}
                <div class="sidebar-section">
                    <h3>
                        Results {#if !search.searching}({search.results.length}){/if}
                    </h3>
                    {#if search.searching && search.results.length === 0}
                        <p class="search-note">Searching...</p>
                    {:else if search.failed}
                        <p class="search-note error">Search is unavailable right now</p>
                    {:else if search.results.length === 0}
                        <p class="search-note">Nothing matches "{searchInput.trim()}"</p>
                    {:else}
                        <ul class="doc-list">
                            {#each search.results as hit, i (hit.id)}
                                <li class="doc-item">
                                    <button
                                        class="search-hit"
                                        class:current={currentDocId === hit.id}
                                        class:selected={i === search.selected}
                                        onclick={() => openSearchHit(hit)}
                                    >
                                        <span class="search-hit-title">
                                            {hit.title}
                                            {#if hit.doc_type === 'journal'}
                                                <span class="search-hit-kind">journal</span>
                                            {/if}
                                        </span>
                                        {#if hit.snippet}
                                            <span class="search-hit-snippet">
                                                {#each snippetParts(hit.snippet) as part, pi (pi)}{#if part.match}<mark
                                                            >{part.text}</mark
                                                        >{:else}{part.text}{/if}{/each}
                                            </span>
                                        {/if}
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            {:else}
                <!-- The calendar, always, and no heading over it. It is how a
                     journal is found: a journal is named for its day, so a
                     month grid marking the days with something written in
                     them beats a column of dates, and it says what it is
                     without being told. -->
                <div class="sidebar-section">
                    <JournalCalendar
                        {journals}
                        {currentJournalTitle}
                        {today}
                        onPick={openJournalFor}
                    />
                </div>

                <div class="sidebar-section">
                    <h3>
                        Notes
                        <button class="add-doc-btn" onclick={() => (showModal = true)}>+</button>
                    </h3>
                    <DocumentList
                        documents={notes}
                        {currentDocId}
                        {openMenuId}
                        onOpen={handleDocClick}
                        onToggleMenu={toggleMenu}
                        onRename={startRename}
                        onDelete={startDelete}
                    />
                </div>

                <div class="sidebar-section">
                    <h3>Index</h3>
                    <!-- The calendar above shows one month; this is the whole
                         run of them, which is the only way to see how far back
                         the journal goes. -->
                    <button class="nav-item" class:active={onJournalsPage} onclick={goToJournals}>
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M8 2v4M16 2v4M3 10h18" />
                            <rect x="3" y="4" width="18" height="18" rx="2" />
                        </svg>
                        <span class="nav-label">Journals</span>
                        {#if journalDayCount > 0}
                            <span class="nav-count">{journalDayCount}</span>
                        {/if}
                    </button>
                    <button class="nav-item" class:active={onTodosPage} onclick={goToTodos}>
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="m7.5 12 3 3 6-6" />
                            <path
                                d="M7.8 21h8.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 18.72 21 17.88 21 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 5.28 3 6.12 3 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C5.28 21 6.12 21 7.8 21"
                            />
                        </svg>
                        <span class="nav-label">Todos</span>
                        {#if openTodoCount > 0}
                            <span class="nav-count">{openTodoCount}</span>
                        {/if}
                    </button>
                    <button class="nav-item" class:active={onTagsPage} onclick={goToTags}>
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M9 9h.01" />
                            <path
                                d="M3.6 13.83l6.58 6.58a2 2 0 0 0 2.83 0l6.59-6.59a2 2 0 0 0 .58-1.41V4a2 2 0 0 0-2-2h-7.83a2 2 0 0 0-1.41.58L3.6 11a2 2 0 0 0 0 2.83"
                            />
                        </svg>
                        <span class="nav-label">Tags</span>
                        {#if $tagCount > 0}
                            <span class="nav-count">{$tagCount}</span>
                        {/if}
                    </button>
                </div>
            {/if}

            <SidebarDeviceList onManage={goToSync} />
        </div>

        <div class="sidebar-footer">
            <button
                class="version-btn"
                onclick={() => (showAbout = true)}
                title="About Oyot and what's new"
            >
                v{APP_VERSION}
            </button>
            <button class="settings-btn" onclick={goToSettings} title="Settings">
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <circle cx="12" cy="12" r="3" />
                    <path
                        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                    />
                </svg>
            </button>
        </div>
    {/if}
</aside>

{#if small && !collapsed}
    <!-- Tapping away closes it, which is the only way out on a phone once the
         sidebar covers the editor. -->
    <div class="sidebar-scrim" role="presentation" onclick={() => (collapsed = true)}></div>
{/if}

<!-- The only control outside the sidebar, and only when there is no sidebar
     to put it in. Collapsing happens from the header, beside the search box. -->
{#if collapsed}
    <button class="expand-btn" onclick={() => (collapsed = false)} title="Expand">
        <svg
            width="20"
            height="20"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            ><path
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="m13 17 5-5-5-5M6 17l5-5-5-5"
            /></svg
        >
    </button>
{/if}

{#if showModal}
    <NewNoteDialog onClose={() => (showModal = false)} />
{/if}

{#if renameDoc}
    <RenameNoteDialog doc={renameDoc} onClose={() => (renameDoc = null)} />
{/if}

{#if deleteDoc}
    <DeleteNoteDialog doc={deleteDoc} onClose={() => (deleteDoc = null)} />
{/if}

{#if showAbout}
    <AboutDialog onClose={() => (showAbout = false)} />
{/if}

<style>
    .sidebar {
        width: 250px;
        min-width: 250px;
        background: var(--bg-secondary);
        border-right: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition:
            width 0.2s ease,
            min-width 0.2s ease;
    }

    .sidebar.collapsed {
        display: none;
    }

    /* Over the editor, not beside it. As a column on a 375px screen it left
       about 125px to write in. */
    .sidebar.overlay {
        position: fixed;
        top: var(--safe-top);
        bottom: var(--safe-bottom);
        left: var(--safe-left);
        z-index: 120;
        box-shadow: 0 0 24px rgba(0, 0, 0, 0.25);
    }

    .sidebar-scrim {
        position: fixed;
        inset: 0;
        z-index: 110;
        background: rgba(0, 0, 0, 0.35);
    }

    /* Beside the search box, sized to match it. */
    .collapse-btn {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 0;
        background: none;
        border: none;
        border-radius: 4px;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .collapse-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* Floating, because with the sidebar hidden there is nothing to sit in. */
    .expand-btn {
        position: fixed;
        left: calc(20px + var(--safe-left));
        bottom: calc(48px + var(--safe-bottom));
        z-index: 100;
        width: 40px;
        height: 40px;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        cursor: pointer;
        transition:
            box-shadow 0.2s ease,
            transform 0.2s ease;
    }

    .expand-btn:hover {
        color: var(--text-primary);
        box-shadow: 0 0 16px 4px rgba(59, 130, 246, 0.4);
    }

    .sidebar-header {
        padding: 12px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-shrink: 0;
        height: 57px;
        box-sizing: border-box;
    }

    .search-input {
        flex: 1;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        background: var(--bg-primary);
        color: var(--text-primary);
        height: 32px;
        box-sizing: border-box;
        min-width: 0;
    }

    .search-input::placeholder {
        color: var(--text-muted);
    }

    /* scrollable middle area */
    .sidebar-content {
        flex: 1;
        overflow-y: auto;
    }

    .sidebar-section {
        padding: 12px;
    }

    .sidebar-section h3 {
        font-size: 12px;
        text-transform: uppercase;
        color: var(--text-secondary);
        margin: 0 0 8px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .search-note {
        margin: 0;
        padding: 8px 4px;
        font-size: 12px;
        color: var(--text-muted);
    }
    .search-note.error {
        color: #d9534f;
    }
    .search-hit {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        padding: 6px 8px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-primary);
    }
    .search-hit:hover {
        background: var(--bg-hover);
    }
    .search-hit.current {
        background: var(--accent-bg);
    }
    .search-hit-title {
        font-size: 13px;
        font-weight: 500;
    }
    .search-hit-kind {
        margin-left: 6px;
        font-size: 10px;
        font-weight: 400;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
    }
    .search-hit.selected {
        background: var(--bg-hover);
        outline: 2px solid var(--accent-color);
        outline-offset: -2px;
    }
    .search-hit-snippet :global(mark) {
        background: var(--accent-bg-hover);
        color: var(--text-primary);
        border-radius: 2px;
        padding: 0 1px;
    }
    .search-hit-snippet {
        font-size: 11px;
        line-height: 1.4;
        color: var(--text-secondary);
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
    }

    /* ── Index section ── */
    .nav-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 8px;
        background: transparent;
        border: none;
        border-radius: 4px;
        color: var(--text-primary);
        font-size: 13px;
        font-family: inherit;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
    }

    .nav-item:hover {
        background: var(--bg-hover);
    }

    .nav-item.active {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .nav-label {
        flex: 1;
        min-width: 0;
    }

    .nav-count {
        flex-shrink: 0;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted);
    }

    .nav-item.active .nav-count {
        color: var(--accent-color);
    }

    .add-doc-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
    }

    .add-doc-btn:hover {
        color: var(--text-primary);
    }

    /* ── Sidebar footer ── */
    /* Pinned so the "Linked from" bar under the editor can match it. */
    .sidebar-footer {
        flex-shrink: 0;
        height: 65px;
        padding: 12px;
        border-top: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .version-btn {
        min-width: 0;
        padding: 6px 8px;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: var(--text-muted);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition:
            background-color 0.15s,
            color 0.15s;
    }

    .version-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .settings-btn {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        cursor: pointer;
        transition:
            background-color 0.15s,
            color 0.15s;
    }

    .settings-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* ── Calendar ── */
</style>
