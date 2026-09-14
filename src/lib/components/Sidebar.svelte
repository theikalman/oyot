<script lang="ts">
    import { appStore, documents } from '../stores/app';
    import {
        pairedDevices,
        connectedPeerIds,
        reconnectingPeerIds,
        roomSync,
        signalingStatus,
    } from '../stores/sync';
    import { reconnectPeer } from '../sync';
    import type { DocumentSummary } from '../types';
    import { invoke } from '@tauri-apps/api/core';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import {
        createNote,
        createJournalForDate as createJournalForDateAction,
        renameDocument,
        deleteDocument as deleteDocumentAction,
    } from '../services/documentActions';
    import { openDocument, openHome } from '../services/navigation';
    import { toasts } from '../services/toast';
    import { snippetParts } from '../search/snippet';
    import AboutDialog from './AboutDialog.svelte';
    import { APP_VERSION } from '../version';

    // Navigate; the document route loads it. Fetching and assigning the store
    // here meant the URL never changed, so there was nothing to go back to.
    function handleDocClick(doc: DocumentSummary) {
        void openDocument(doc.id);
        dismissOnSmallScreen();
    }

    let searchInput = $state('');
    let showModal = $state(false);
    let newDocTitle = $state('');
    // Tablets and phones start with the sidebar hidden so the editor gets the full
    // width; the floating toggle button is still there to bring it back.
    const SMALL_SCREEN_QUERY = '(max-width: 768px)';

    function isSmallScreen(): boolean {
        return typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_QUERY).matches;
    }

    let collapsed = $state(isSmallScreen());
    let small = $state(isSmallScreen());
    let showCalendar = $state(false);

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

    let currentDate = $state(new Date());

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

    let currentDocId = $derived($appStore.currentDocument?.id);
    let currentJournalTitle = $derived(
        $appStore.currentDocument?.doc_type === 'journal' ? $appStore.currentDocument.title : null,
    );
    let journals = $derived($documents.filter((d: DocumentSummary) => d.doc_type === 'journal'));
    let notes = $derived($documents.filter((d: DocumentSummary) => d.doc_type === 'note'));
    let journalsNewestFirst = $derived(
        [...journals].sort((a, b) => b.title.localeCompare(a.title)),
    );

    // Search runs in SQL over an FTS index of titles and bodies, so it finds
    // what the user wrote, not just what they named it, and covers journals as
    // well as notes. It used to be a substring match on note titles only.
    interface SearchHit {
        id: string;
        doc_type: string;
        title: string;
        snippet: string;
    }

    let searchResults = $state<SearchHit[]>([]);
    let isSearching = $state(false);
    // A failed search must not render as "nothing matches": that reads as an
    // answer when it is the absence of one.
    let searchFailed = $state(false);
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let searchSeq = 0;
    // Which hit the arrow keys have moved to. Reset whenever the results
    // change, so Enter never opens a document the user cannot see highlighted.
    let selectedHit = $state(0);

    let isSearchActive = $derived(searchInput.trim().length > 0);

    async function runSearch(query: string) {
        const seq = ++searchSeq;
        try {
            const hits = await invoke<SearchHit[]>('search_documents', { query });
            // Drop a response that a newer keystroke has already superseded.
            if (seq !== searchSeq) return;
            searchResults = hits;
            searchFailed = false;
            selectedHit = 0;
        } catch (err) {
            if (seq !== searchSeq) return;
            console.error('[Sidebar] Search failed:', err);
            searchResults = [];
            searchFailed = true;
        } finally {
            if (seq === searchSeq) isSearching = false;
        }
    }

    $effect(() => {
        const query = searchInput.trim();
        if (searchTimer) clearTimeout(searchTimer);

        if (!query) {
            searchSeq++; // invalidate anything in flight
            searchResults = [];
            searchFailed = false;
            isSearching = false;
            return;
        }

        isSearching = true;
        searchTimer = setTimeout(() => void runSearch(query), 150);

        // Without this the pending timer outlives the component: navigating
        // to settings mid-keystroke fired a search that then wrote its result
        // into state nothing is rendering any more.
        return () => {
            if (searchTimer) {
                clearTimeout(searchTimer);
                searchTimer = null;
            }
        };
    });

    // Arrow keys move through the results and Enter opens one, so a search
    // can be completed without leaving the keyboard. Escape clears the box,
    // which is also how you get back to the document list.
    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            searchInput = '';
            return;
        }
        if (searchResults.length === 0) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedHit = (selectedHit + 1) % searchResults.length;
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedHit = (selectedHit - 1 + searchResults.length) % searchResults.length;
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const hit = searchResults[selectedHit];
            if (hit) openSearchHit(hit);
        }
    }

    function openSearchHit(hit: SearchHit) {
        void openDocument(hit.id);
        dismissOnSmallScreen();
    }

    let createError = $state<string | null>(null);

    async function createDocument() {
        if (!newDocTitle.trim()) return;

        createError = null;
        let doc;
        try {
            doc = await createNote(newDocTitle.trim());
        } catch (error) {
            // Keep the dialog open with what was typed still in it. Closing
            // regardless discarded the title and said nothing went wrong.
            console.error('Failed to create document:', error);
            createError = 'Could not create this note.';
            return;
        }
        closeModal();
        await openDocument(doc.id);
    }

    function closeModal() {
        newDocTitle = '';
        createError = null;
        showModal = false;
    }

    let openMenuId = $state<string | null>(null);
    let openDeviceMenuId = $state<string | null>(null);
    let renameDoc = $state<DocumentSummary | null>(null);
    let renameTitle = $state('');
    let deleteDoc = $state<DocumentSummary | null>(null);

    function toggleMenu(e: MouseEvent, docId: string) {
        e.stopPropagation();
        openMenuId = openMenuId === docId ? null : docId;
    }

    function toggleDeviceMenu(e: MouseEvent, peerNodeId: string) {
        e.stopPropagation();
        openDeviceMenuId = openDeviceMenuId === peerNodeId ? null : peerNodeId;
    }

    function handleReconnectDevice(peerNodeId: string) {
        openDeviceMenuId = null;
        void reconnectPeer(peerNodeId);
    }

    function handleWindowClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (!target.closest('.doc-menu-btn') && !target.closest('.doc-menu')) {
            openMenuId = null;
        }
        if (!target.closest('.device-menu-btn') && !target.closest('.device-menu')) {
            openDeviceMenuId = null;
        }
    }

    function startRename(doc: DocumentSummary) {
        renameDoc = doc;
        renameTitle = doc.title;
        openMenuId = null;
    }

    function closeRenameModal() {
        renameDoc = null;
        renameTitle = '';
        renameError = null;
    }

    let renameError = $state<string | null>(null);

    async function confirmRename() {
        if (!renameDoc || !renameTitle.trim()) return;
        const docId = renameDoc.id;
        const title = renameTitle.trim();

        renameError = null;
        try {
            await renameDocument(docId, title);
        } catch (err) {
            // Closing in a `finally` threw the edit away on failure and left
            // the user believing the rename had worked.
            console.error('[Sidebar] Failed to rename document:', err);
            renameError = 'Could not rename this note.';
            return;
        }
        closeRenameModal();
    }

    function startDelete(doc: DocumentSummary) {
        deleteDoc = doc;
        openMenuId = null;
    }

    function closeDeleteModal() {
        deleteDoc = null;
        deleteError = null;
    }

    let deleteError = $state<string | null>(null);

    async function confirmDelete() {
        if (!deleteDoc) return;
        const docId = deleteDoc.id;
        const wasOpen = currentDocId === docId;

        // Nothing is cleared until the delete has actually succeeded. Clearing
        // the open document first left the editor on a permanent "Loading..."
        // with no way back whenever the delete failed, and whenever the note
        // deleted was the last one.
        deleteError = null;
        try {
            await deleteDocumentAction(docId);
        } catch (err) {
            console.error('[Sidebar] Failed to delete document:', err);
            deleteError = 'Could not delete this note.';
            return;
        }

        closeDeleteModal();
        if (wasOpen) {
            const nextNote = notes.find((d: DocumentSummary) => d.id !== docId);
            // No note left to fall back to, so go to the entry point, which
            // opens today's journal.
            await (nextNote ? openDocument(nextNote.id) : openHome());
        }
    }

    let showAbout = $state(false);

    function goToSettings() {
        goto(resolve('/settings'));
    }

    function goToSync() {
        goto(resolve('/settings/sync'));
    }

    function prevMonth() {
        currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    }

    function nextMonth() {
        currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    }

    function getCalendarDays() {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const days: (number | null)[] = [];

        for (let i = 0; i < firstDay; i++) days.push(null);
        for (let d = 1; d <= daysInMonth; d++) days.push(d);
        while (days.length % 7 !== 0) days.push(null);

        return days;
    }

    const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
    ];
    const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    let calendarDays = $derived(getCalendarDays());
    let calendarMonthYear = $derived(
        `${monthNames[currentDate.getMonth()]} ${currentDate.getFullYear()}`,
    );

    function handleDateClick(day: number | null) {
        if (day === null) return;
        const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const dayStr = String(date.getDate()).padStart(2, '0');
        const dateTitle = `${year}-${month}-${dayStr}`;

        const existing = journals.find((d: DocumentSummary) => d.title === dateTitle);
        if (existing) {
            handleDocClick(existing);
        } else {
            createJournalForDate(dateTitle);
        }
    }

    async function createJournalForDate(dateTitle: string) {
        try {
            const doc = await createJournalForDateAction(dateTitle);
            await openDocument(doc.id);
            dismissOnSmallScreen();
        } catch (err) {
            console.error('[Sidebar] Failed to create journal for date:', dateTitle, err);
            toasts.error('Could not open that day');
        }
    }

    // Reads the tracked date, not a fresh one, so the highlight moves when
    // the day does rather than whenever something else happens to re-render.
    function isToday(day: number | null): boolean {
        if (day === null) return false;
        return (
            day === today.getDate() &&
            currentDate.getMonth() === today.getMonth() &&
            currentDate.getFullYear() === today.getFullYear()
        );
    }

    function isSelectedDate(day: number | null): boolean {
        if (day === null || !currentJournalTitle) return false;
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        return currentJournalTitle === `${year}-${month}-${dayStr}`;
    }

    function hasJournal(day: number | null): boolean {
        if (day === null) return false;
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const dateTitle = `${year}-${month}-${dayStr}`;
        return journals.some((d: DocumentSummary) => d.title === dateTitle && d.has_content);
    }

    function goToToday() {
        const today = new Date();
        currentDate = today;
        handleDateClick(today.getDate());
    }
</script>

<svelte:window onclick={handleWindowClick} />

<!-- One row, used by both lists. Journals had no list at all before, and
     duplicating seventy lines of markup to give them one is how the two
     quietly drift apart. -->
{#snippet documentRow(doc: DocumentSummary)}
    <li class="doc-item">
        <button
            class="doc-btn"
            class:current={currentDocId === doc.id}
            onclick={() => handleDocClick(doc)}
        >
            <span class="doc-type"
                ><svg
                    width="16"
                    height="16"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    ><path
                        stroke="#A1A1A1"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M14 2.27V6.4c0 .56 0 .84.109 1.054a1 1 0 0 0 .437.437c.214.11.494.11 1.054.11h4.13M16 13H8m8 4H8m2-8H8m6-7H8.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C4 4.28 4 5.12 4 6.8v10.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C6.28 22 7.12 22 8.8 22h6.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C20 19.72 20 18.88 20 17.2V8z"
                    /></svg
                ></span
            >
            {doc.title}
            {#if doc.todo_count > 0}
                <span
                    class="todo-badge"
                    class:done={doc.completed_todo_count === doc.todo_count}
                    title="{doc.completed_todo_count} of {doc.todo_count} done"
                >
                    {doc.completed_todo_count}/{doc.todo_count}
                </span>
            {/if}
        </button>
        <button class="doc-menu-btn" onclick={(e) => toggleMenu(e, doc.id)} title="Note options">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle
                    cx="12"
                    cy="19"
                    r="1"
                /></svg
            >
        </button>
        {#if openMenuId === doc.id}
            <div class="doc-menu">
                <button class="doc-menu-item" onclick={() => startRename(doc)}>Rename</button>
                <button class="doc-menu-item danger" onclick={() => startDelete(doc)}>Delete</button
                >
            </div>
        {/if}
    </li>
    \n{/snippet}\n\n
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
        {/if}
    </div>

    {#if !collapsed}
        <div class="sidebar-content">
            {#if isSearchActive}
                <div class="sidebar-section">
                    <h3>
                        Results {#if !isSearching}({searchResults.length}){/if}
                    </h3>
                    {#if isSearching && searchResults.length === 0}
                        <p class="search-note">Searching...</p>
                    {:else if searchFailed}
                        <p class="search-note error">Search is unavailable right now</p>
                    {:else if searchResults.length === 0}
                        <p class="search-note">Nothing matches "{searchInput.trim()}"</p>
                    {:else}
                        <ul class="doc-list">
                            {#each searchResults as hit, i (hit.id)}
                                <li class="doc-item">
                                    <button
                                        class="search-hit"
                                        class:current={currentDocId === hit.id}
                                        class:selected={i === selectedHit}
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
                <div class="sidebar-section">
                    {#if showCalendar}
                        <div class="calendar">
                            <div class="calendar-header">
                                <button
                                    class="cal-nav-btn"
                                    onclick={prevMonth}
                                    title="Previous month"
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg
                                    >
                                </button>
                                <div class="cal-center">
                                    <span class="calendar-title">{calendarMonthYear}</span>
                                    <button class="today-btn" onclick={goToToday}>Today</button>
                                </div>
                                <button class="cal-nav-btn" onclick={nextMonth} title="Next month">
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg
                                    >
                                </button>
                            </div>
                            <div class="calendar-grid">
                                {#each dayNames as d (d)}
                                    <div class="cal-day-name">{d}</div>
                                {/each}
                                {#each calendarDays as day, i (i)}
                                    <button
                                        class="cal-day"
                                        class:empty={day === null}
                                        class:today={isToday(day)}
                                        class:selected={isSelectedDate(day)}
                                        onclick={() => handleDateClick(day)}
                                        disabled={day === null}
                                    >
                                        {#if hasJournal(day)}
                                            <span class="journal-dot"></span>
                                        {/if}
                                        {day ?? ''}
                                    </button>
                                {/each}
                            </div>
                        </div>
                    {/if}
                </div>

                <div class="sidebar-section">
                    <h3>
                        Journals ({journals.length})
                        <button
                            class="cal-toggle-btn"
                            onclick={() => (showCalendar = !showCalendar)}
                            title="Toggle calendar"
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                                ><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g
                                    id="SVGRepo_tracerCarrier"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                ></g><g id="SVGRepo_iconCarrier">
                                    <path
                                        d="M3 9H21M7 3V5M17 3V5M6 13H8M6 17H8M11 13H13M11 17H13M16 13H18M16 17H18M6.2 21H17.8C18.9201 21 19.4802 21 19.908 20.782C20.2843 20.5903 20.5903 20.2843 20.782 19.908C21 19.4802 21 18.9201 21 17.8V8.2C21 7.07989 21 6.51984 20.782 6.09202C20.5903 5.71569 20.2843 5.40973 19.908 5.21799C19.4802 5 18.9201 5 17.8 5H6.2C5.0799 5 4.51984 5 4.09202 5.21799C3.71569 5.40973 3.40973 5.71569 3.21799 6.09202C3 6.51984 3 7.07989 3 8.2V17.8C3 18.9201 3 19.4802 3.21799 19.908C3.40973 20.2843 3.71569 20.5903 4.09202 20.782C4.51984 21 5.07989 21 6.2 21Z"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                    ></path>
                                </g></svg
                            >
                        </button>
                    </h3>
                    <!-- Journals were reachable only through the calendar,
                         which is hidden by default, and could not be renamed
                         or deleted at all. Newest first: the one you want is
                         almost always a recent one. -->
                    <ul class="doc-list">
                        {#each journalsNewestFirst as doc (doc.id)}
                            {@render documentRow(doc)}
                        {/each}
                    </ul>
                </div>

                <div class="sidebar-section">
                    <h3>
                        Notes
                        <button class="add-doc-btn" onclick={() => (showModal = true)}>+</button>
                    </h3>
                    <ul class="doc-list">
                        {#each notes as doc (doc.id)}
                            {@render documentRow(doc)}
                        {/each}
                    </ul>
                </div>
            {/if}

            <div class="sidebar-section">
                <h3>
                    Connected Devices
                    <button class="cal-toggle-btn" onclick={goToSync} title="Manage devices">
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            ><path
                                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                            /></svg
                        >
                    </button>
                </h3>
                {#if $pairedDevices.length === 0}
                    <p class="empty-hint">No paired devices yet</p>
                {:else}
                    <ul class="device-list">
                        {#each $pairedDevices as device (device.peer_node_id)}
                            {@const online = $connectedPeerIds.has(device.peer_node_id)}
                            {@const reconnecting = $reconnectingPeerIds.has(device.peer_node_id)}
                            {@const rs = $roomSync[device.room_id]}
                            <li class="device-item">
                                <span class="device-dot" class:online></span>
                                <span class="device-name">{device.peer_display_name}</span>
                                <span class="device-status">
                                    {#if !online}
                                        {reconnecting ? 'Connecting…' : 'Offline'}
                                    {:else if rs?.phase === 'transferring' && rs.total > 0}
                                        {rs.total - rs.pending}/{rs.total}
                                    {:else if rs?.phase === 'reconciling' || rs?.phase === 'transferring'}
                                        Syncing…
                                    {:else if rs?.phase === 'error'}
                                        Error
                                    {:else}
                                        Online
                                    {/if}
                                </span>
                                <button
                                    class="device-menu-btn"
                                    onclick={(e) => toggleDeviceMenu(e, device.peer_node_id)}
                                    title="Device options"
                                >
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="2"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        ><circle cx="12" cy="5" r="1" /><circle
                                            cx="12"
                                            cy="12"
                                            r="1"
                                        /><circle cx="12" cy="19" r="1" /></svg
                                    >
                                </button>
                                {#if openDeviceMenuId === device.peer_node_id}
                                    <div class="device-menu">
                                        <button
                                            class="doc-menu-item"
                                            disabled={online || $signalingStatus !== 'connected'}
                                            onclick={() =>
                                                handleReconnectDevice(device.peer_node_id)}
                                        >
                                            {reconnecting ? 'Reconnect now' : 'Reconnect'}
                                        </button>
                                    </div>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>
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

<button
    class="toggle-btn"
    class:collapsed
    onclick={() => (collapsed = !collapsed)}
    title={collapsed ? 'Expand' : 'Collapse'}
>
    {#if collapsed}
        <svg
            width="20"
            height="20"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            ><path
                stroke="#A1A1A1"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M3 12h18M3 6h18M3 18h12"
            /></svg
        >
    {:else}
        <svg
            width="20"
            height="20"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            ><path
                stroke="#A1A1A1"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M3 12h18M3 6h18M9 18h12"
            /></svg
        >
    {/if}
</button>

{#if showModal}
    <div class="modal-overlay" role="presentation" onclick={closeModal}>
        <div
            class="modal-content"
            role="dialog"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.key === 'Escape' && closeModal()}
        >
            <h3>New Note</h3>
            <input
                type="text"
                bind:value={newDocTitle}
                placeholder="Enter file name..."
                class="modal-input"
                onkeydown={(e) => e.key === 'Enter' && createDocument()}
            />
            {#if createError}
                <p class="modal-error">{createError}</p>
            {/if}
            <div class="modal-actions">
                <button class="modal-btn" onclick={createDocument}>OK</button>
            </div>
        </div>
    </div>
{/if}

{#if renameDoc}
    <div class="modal-overlay" role="presentation" onclick={closeRenameModal}>
        <div
            class="modal-content"
            role="dialog"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.key === 'Escape' && closeRenameModal()}
        >
            <h3>Rename</h3>
            <input
                type="text"
                bind:value={renameTitle}
                placeholder="Enter file name..."
                class="modal-input"
                onkeydown={(e) => e.key === 'Enter' && confirmRename()}
            />
            {#if renameError}
                <p class="modal-error">{renameError}</p>
            {/if}
            <div class="modal-actions">
                <button class="modal-btn secondary" onclick={closeRenameModal}>Cancel</button>
                <button class="modal-btn" onclick={confirmRename}>Rename</button>
            </div>
        </div>
    </div>
{/if}

{#if deleteDoc}
    <div class="modal-overlay" role="presentation" onclick={closeDeleteModal}>
        <div
            class="modal-content"
            role="dialog"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.key === 'Escape' && closeDeleteModal()}
        >
            <h3>Delete "{deleteDoc.title}"?</h3>
            <p class="modal-warning">
                This can't be undone. If this note has been synchronized to other devices, it will
                be deleted there too.
            </p>
            {#if deleteError}
                <p class="modal-error">{deleteError}</p>
            {/if}
            <div class="modal-actions">
                <button class="modal-btn secondary" onclick={closeDeleteModal}>Cancel</button>
                <button class="modal-btn danger" onclick={confirmDelete}>Delete</button>
            </div>
        </div>
    </div>
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
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 120;
        box-shadow: 0 0 24px rgba(0, 0, 0, 0.25);
    }

    .sidebar-scrim {
        position: fixed;
        inset: 0;
        z-index: 110;
        background: rgba(0, 0, 0, 0.35);
    }

    .toggle-btn {
        width: 40px;
        height: 40px;
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: var(--text-secondary);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        margin-left: auto;
    }

    .toggle-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .toggle-btn.collapsed {
        position: fixed;
        left: 20px;
        bottom: 48px;
        z-index: 100;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        transition:
            box-shadow 0.2s ease,
            transform 0.2s ease;
    }

    .toggle-btn.collapsed:hover {
        box-shadow: 0 0 16px 4px rgba(59, 130, 246, 0.4);
    }

    .toggle-btn.collapsed svg {
        width: 20px;
        height: 20px;
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

    .todo-badge {
        margin-left: 6px;
        padding: 1px 6px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        background: var(--bg-hover);
        border-radius: 8px;
        white-space: nowrap;
    }
    .todo-badge.done {
        color: var(--accent-color);
        background: var(--accent-bg);
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

    .doc-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .doc-list li {
        margin-bottom: 4px;
    }

    .doc-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .doc-btn {
        flex: 1;
        min-width: 0;
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .doc-btn:hover {
        background: var(--bg-hover);
    }

    .doc-btn.current {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .doc-menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
    }

    .doc-item:hover .doc-menu-btn,
    .doc-menu-btn:focus-visible {
        opacity: 1;
    }

    .doc-menu-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .doc-menu {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        z-index: 50;
        min-width: 120px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .doc-menu-item {
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
        color: var(--text-primary);
    }

    .doc-menu-item:hover {
        background: var(--bg-hover);
    }

    .doc-menu-item.danger {
        color: #ef4444;
    }

    .doc-type {
        margin-right: 6px;
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        margin-top: -4px;
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

    .cal-toggle-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        display: flex;
        align-items: center;
        color: var(--text-secondary);
    }

    .cal-toggle-btn:hover {
        color: var(--text-primary);
    }

    .empty-hint {
        margin: 0;
        font-size: 13px;
        color: var(--text-muted);
    }

    .device-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }

    .device-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-primary);
    }

    .device-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-muted);
    }

    .device-dot.online {
        background: #22c55e;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.2);
    }

    .device-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .device-status {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--text-muted);
    }

    .device-menu-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
    }

    .device-item:hover .device-menu-btn,
    .device-menu-btn:focus-visible {
        opacity: 1;
    }

    .device-menu-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .device-menu {
        position: absolute;
        top: calc(100% + 2px);
        right: 0;
        z-index: 50;
        min-width: 140px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        padding: 4px;
        display: flex;
        flex-direction: column;
    }

    .doc-menu-item:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .doc-menu-item:disabled:hover {
        background: transparent;
    }

    /* ── Sidebar footer ── */
    .sidebar-footer {
        flex-shrink: 0;
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

    /* ── Modals ── */
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .modal-content {
        background: var(--bg-primary);
        padding: 20px;
        border-radius: 8px;
        min-width: 300px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        color: var(--text-primary);
    }

    .modal-content h3 {
        margin: 0 0 12px 0;
        font-size: 16px;
        color: var(--text-primary);
    }

    .modal-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 14px;
        box-sizing: border-box;
        background: var(--bg-secondary);
        color: var(--text-primary);
    }

    .modal-input::placeholder {
        color: var(--text-muted);
    }

    .modal-error {
        margin: 0 0 12px 0;
        font-size: 13px;
        color: var(--status-error);
    }

    .modal-warning {
        margin: 0 0 4px 0;
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.4;
    }

    .modal-actions {
        margin-top: 12px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    .modal-btn {
        padding: 6px 16px;
        background: var(--btn-primary-bg);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
    }

    .modal-btn:hover {
        background: var(--btn-primary-hover);
    }

    .modal-btn.secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
    }

    .modal-btn.secondary:hover {
        background: var(--bg-hover);
    }

    .modal-btn.danger {
        background: #ef4444;
    }

    .modal-btn.danger:hover {
        background: #dc2626;
    }

    /* ── Calendar ── */
    .calendar {
        border: 1px solid var(--border-light);
        border-radius: 8px;
        padding: 8px;
        background: var(--bg-primary);
    }

    .calendar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }

    .calendar-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .cal-center {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }

    .today-btn {
        background: none;
        border: 1px solid var(--border-light);
        cursor: pointer;
        padding: 2px 8px;
        color: var(--text-secondary);
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        transition:
            background 0.1s,
            color 0.1s;
    }

    .today-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .cal-nav-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        color: var(--text-secondary);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .cal-nav-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
    }

    .cal-day-name {
        text-align: center;
        font-size: 10px;
        color: var(--text-muted);
        padding: 2px 0;
        font-weight: 600;
    }

    .cal-day {
        aspect-ratio: 1;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        color: var(--text-primary);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.1s;
    }

    .journal-dot {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: #666;
        pointer-events: none;
    }

    .cal-day:hover:not(:disabled):not(.empty) {
        background: var(--bg-hover);
    }

    .cal-day.today {
        background: var(--accent-bg);
        color: var(--accent-color);
        font-weight: 700;
    }

    .cal-day.selected:not(.today) {
        box-shadow: inset 0 0 0 1.5px var(--accent-color);
    }

    .cal-day.today.selected {
        box-shadow: inset 0 0 0 2px var(--accent-color);
    }

    .cal-day.empty {
        cursor: default;
    }

    .cal-day:disabled {
        cursor: default;
    }
</style>
