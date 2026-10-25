<script lang="ts">
    import { untrack } from 'svelte';
    import { page } from '$app/state';
    import { currentDocument, appStore } from '$lib/stores/app';
    import { loadDocument } from '$lib/services/documents';
    import { documentView } from '$lib/editor/documentView';
    import { opensForEditing } from '$lib/editor/editorMode';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import Editor from '$lib/editor/Editor.svelte';
    import EditToggle from '$lib/editor/EditToggle.svelte';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import PinToggle from '$lib/components/PinToggle.svelte';
    import Icon from '$lib/components/Icon.svelte';
    import { swipe } from '$lib/gestures/swipe';
    import { openJournal } from '$lib/services/journals';
    import { toasts } from '$lib/services/toast';
    import {
        addDays,
        isoWeek,
        journalDateOf,
        journalTitleFor,
        longJournalTitle,
        monthLabel,
    } from '$lib/calendar/calendar';
    import { documents } from '$lib/stores/app';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { loadTagsByDocument } from '$lib/services/tags';
    import { NO_TAGS, tagsOf, type TagsByDocument } from '$lib/tags/documentTags';
    import { viewport } from '$lib/utils/viewport.svelte';
    import PhoneSyncDot from '$lib/components/PhoneSyncDot.svelte';
    import WeekStrip from '$lib/components/WeekStrip.svelte';

    let activeDocument = $derived($currentDocument);

    // The URL is what says which document is open, so opening one is a
    // navigation and the back button works. Before this the only record was a
    // store, so there were no deep links, no history, and Android's hardware
    // back key exited the app from the only route there was.
    let routeId = $derived(page.params.id);

    // `?todo=` says which task item to put the cursor on, set by the todo
    // index when one of its rows is clicked. In the URL rather than in a
    // store so the jump survives a reload and the back button undoes it.
    let focusTodo = $derived.by(() => {
        const raw = page.url.searchParams.get('todo');
        if (raw === null) return null;
        const ordinal = Number(raw);
        return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : null;
    });
    let loadFailed = $state(false);

    // The last document this page had open. A document removed while open,
    // deleted here or by a paired device, leaves nothing open while the URL
    // still names it, and this is what tells that apart from a document that
    // has not arrived yet.
    let shownId = $state<string | null>(null);

    // Which document, if any, is being edited. Every open starts out
    // reading, notes and journals alike, and Edit is a choice made each time,
    // so looking something up cannot also change it by a stray tap. A note
    // just created is the exception, see $lib/editor/editorMode. Held here,
    // not in the editor, because this is what knows when a document is
    // opened, and opening is what sets it back.
    //
    // An id rather than a flag, so the choice belongs to one document. The
    // one being left stays on screen until the next has loaded, and a flag
    // set for a new note would have made that one editable in the meantime.
    let editingId = $state<string | null>(null);
    let editing = $derived(editingId !== null && editingId === activeDocument?.id);

    // Loads when the URL names a document that is not open. Only a change of
    // URL is a reason to, so the open document is read without subscribing to
    // it: it going away is not one. That is a document removed while it was
    // open, and loading it again can only fail. It used to, with an error
    // toast, every time a note was deleted while on screen.
    $effect(() => {
        const id = routeId;
        loadFailed = false;
        if (!id) return;
        editingId = opensForEditing(id) ? id : null;
        if (id === untrack(() => $currentDocument?.id)) {
            shownId = id;
            return;
        }

        let cancelled = false;
        void loadDocument(id)
            .then((doc) => {
                if (cancelled) return;
                appStore.setCurrentDocument(doc);
                shownId = doc.id;
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

    let view = $derived(documentView({ routeId, openId: activeDocument?.id, shownId, loadFailed }));

    // A journal is headed by its day written out, "Saturday, 24 October
    // 2026", rather than the YYYY-MM-DD it is stored under.
    let journalDate = $derived(
        activeDocument?.doc_type === 'journal' ? journalDateOf(activeDocument.title) : null,
    );
    let heading = $derived(
        activeDocument
            ? ((journalDate && longJournalTitle(activeDocument.title)) ?? activeDocument.title)
            : null,
    );
    let isToday = $derived(
        journalDate !== null && activeDocument?.title === journalTitleFor(new Date()),
    );

    // The arrows beside a journal's day, which do what the day before and
    // day after keys do.
    async function stepDay(delta: number) {
        if (!journalDate) return;
        const title = journalTitleFor(addDays(journalDate, delta));
        try {
            await openJournal(title);
        } catch (error) {
            console.error('[journal] could not open', title, error);
            toasts.error('Could not open that day');
        }
    }

    // ── On a phone ──
    // The header names the month, which opens the month in place of the
    // week; the journal itself is headed in the page by its day.
    let monthOpen = $state(false);
    let phoneJournal = $derived(viewport.phone && journalDate !== null);

    let journals = $derived($documents.filter((d) => d.doc_type === 'journal'));
    let summary = $derived($documents.find((d) => d.id === activeDocument?.id));
    let openTodos = $derived(
        summary ? Math.max(summary.todo_count - summary.completed_todo_count, 0) : 0,
    );

    let tags = $state<TagsByDocument>(NO_TAGS);
    $effect(() => {
        if (!phoneJournal) return;
        void $indexRevision;
        let live = true;
        void loadTagsByDocument().then((loaded) => {
            if (live) tags = loaded;
        });
        return () => {
            live = false;
        };
    });
    let tagCount = $derived(activeDocument ? tagsOf(tags, activeDocument.id).length : 0);

    // "Saturday, 24 October", with the year only when it is not this one.
    let dayHeading = $derived.by(() => {
        if (!journalDate || !activeDocument) return '';
        const long = longJournalTitle(activeDocument.title) ?? '';
        return journalDate.getFullYear() === new Date().getFullYear()
            ? long.replace(/ \d{4}$/, '')
            : long;
    });

    async function pickDay(title: string) {
        try {
            await openJournal(title);
        } catch (error) {
            console.error('[journal] could not open', title, error);
            toasts.error('Could not open that day');
        }
    }

    function toggleEditing() {
        editingId = editing ? null : (activeDocument?.id ?? null);
    }

    // The Edit button's shortcut, taken wherever focus is on the page, so it
    // works from the document while editing and from nowhere in particular
    // while reading, when the document cannot take focus.
    function withKeys(label: string, id: string): string {
        const keys = customShortcuts.labelFor(id);
        return keys ? `${label} (${keys})` : label;
    }

    function handleKeydown(event: KeyboardEvent) {
        if (view !== 'editor' || !customShortcuts.matches('edit', event)) return;
        event.preventDefault();
        toggleEditing();
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet journalHead()}
    <header class="phone-head">
        <div class="eyebrow">
            {#if isToday}<span class="badge accent">Today</span>{/if}
            {#if journalDate}<span>Week {isoWeek(journalDate)}</span>{/if}
        </div>
        <h1>{dayHeading}</h1>
        <div class="meta">
            {#if openTodos > 0}<span class="badge todo">{openTodos} open</span>{/if}
            {#if tagCount > 0}<span class="badge">{tagCount} {tagCount === 1 ? 'tag' : 'tags'}</span
                >{/if}
        </div>
    </header>
{/snippet}

<WorkspaceShell title={heading}>
    {#snippet phoneBar()}
        {#if journalDate}
            <button
                class="month-btn"
                onclick={() => (monthOpen = !monthOpen)}
                aria-expanded={monthOpen}
            >
                {monthLabel(journalDate)}
                <span class="chev" class:up={monthOpen}><Icon name="chevron-down" size={16} /></span
                >
            </button>
        {:else}
            <span class="phone-title">{activeDocument?.title ?? ''}</span>
            {#if activeDocument?.doc_type === 'note'}
                <PinToggle docId={activeDocument.id} pinned={activeDocument.pinned} />
            {/if}
        {/if}
        <PhoneSyncDot />
        {#if view === 'editor'}
            {#if editing}
                <span class="saved"><Icon name="check" size={14} />Saved</span>
                <button class="m-pill" onclick={toggleEditing}>Done</button>
            {:else}
                <button class="m-btn" onclick={toggleEditing} aria-label="Edit">
                    <Icon name="edit" size={22} />
                </button>
            {/if}
        {/if}
    {/snippet}
    <!-- Reading a note is when deciding to keep it at hand usually happens.
         Only a note: a journal is reached by its day, and nothing lists a
         pinned journal. The pin is kept current on the open document by
         every path that changes it, a peer's included. -->
    {#snippet actions()}
        {#if activeDocument?.doc_type === 'note'}
            <PinToggle docId={activeDocument.id} pinned={activeDocument.pinned} />
        {:else if journalDate}
            {#if isToday}
                <span class="badge accent">Today</span>
            {/if}
            <button
                class="day-step"
                onclick={() => stepDay(-1)}
                title={withKeys('The day before', 'previousDay')}
                aria-label="The day before"><Icon name="chevron-left" /></button
            >
            <button
                class="day-step"
                onclick={() => stepDay(1)}
                title={withKeys('The day after', 'nextDay')}
                aria-label="The day after"><Icon name="chevron-right" /></button
            >
        {/if}
    {/snippet}
    {#snippet tools()}
        {#if view === 'editor'}
            <EditToggle {editing} onToggle={toggleEditing} />
        {/if}
    {/snippet}
    {#if view === 'editor'}
        <!-- On a touch screen, swiping a journal sideways while reading
             turns to the day before or after, as the arrows do. -->
        <div
            class="swipe-area"
            use:swipe={{
                // The week strip swipes its own weeks.
                accept: (e) =>
                    journalDate !== null &&
                    !editing &&
                    !(e.target instanceof Element && e.target.closest('.week-strip')),
                onSwipe: (direction) => stepDay(direction === 'left' ? 1 : -1),
            }}
        >
            {#if phoneJournal && journalDate}
                <WeekStrip
                    date={journalDate}
                    today={new Date()}
                    {journals}
                    bind:expanded={monthOpen}
                    onPick={pickDay}
                />
            {/if}
            <Editor {focusTodo} editable={editing} head={phoneJournal ? journalHead : undefined} />
        </div>
    {:else if view === 'gone'}
        <div class="empty-state">
            <p>That note no longer exists.</p>
        </div>
    {:else}
        <div class="empty-state">
            <p>Loading...</p>
        </div>
    {/if}
</WorkspaceShell>

<style>
    .month-btn {
        flex: 1;
        min-width: 0;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 16px;
        font-weight: 600;
        -webkit-tap-highlight-color: transparent;
    }

    .chev {
        display: grid;
        color: var(--text-muted);
        transition: transform 0.15s;
    }

    .chev.up {
        transform: rotate(180deg);
    }

    .phone-title {
        flex: 1;
        min-width: 0;
        padding: 0 6px;
        font-size: 16px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .saved {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 0 8px;
        font-size: 13px;
        color: var(--text-muted);
    }

    .saved :global(.icon) {
        color: var(--status-ok);
    }

    /* The journal's day, at the head of the page on a phone. */
    .phone-head {
        max-width: 680px;
        margin: 0 auto 18px;
    }

    .eyebrow {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-muted);
    }

    .phone-head h1 {
        margin: 8px 0 10px;
        font-size: 28px;
        line-height: 34px;
        font-weight: 680;
        letter-spacing: -0.028em;
    }

    .meta {
        display: flex;
        gap: 6px;
    }

    .meta:empty {
        display: none;
    }

    .swipe-area {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }

    .day-step {
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        padding: 0;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .day-step:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    /* A phone swipes between days instead, and needs the room for the day. */
    @media (max-width: 480px) {
        .day-step {
            display: none;
        }
    }

    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
    }
</style>
