<script lang="ts">
    import { openDocument, openTag } from '$lib/services/navigation';
    import { setPinned } from '$lib/services/documentActions';
    import { toasts } from '$lib/services/toast';
    import { editedLabel, openTodos, sortNotes, type NoteOrder } from '$lib/notes/noteIndex';
    import { tagsOf, type TagsByDocument } from '$lib/tags/documentTags';
    import { longpress } from '$lib/gestures/longpress';
    import type { DocumentSummary } from '$lib/types';
    import SwipeRow from '$lib/components/SwipeRow.svelte';
    import ActionSheet from '$lib/components/ActionSheet.svelte';
    import TagPill from '$lib/components/TagPill.svelte';
    import Icon from '$lib/components/Icon.svelte';

    // The Notes page on a phone: a large title, the pinned notes as cards to
    // flick through, then every note as a row. Swipe a row left for Pin and
    // Delete; hold a row or a card for everything else, as a sheet.
    interface Props {
        notes: DocumentSummary[];
        shown: DocumentSummary[];
        tags: TagsByDocument;
        filter: string;
        onRename: (note: DocumentSummary) => void;
        onDelete: (note: DocumentSummary) => void;
    }

    let { notes, shown, tags, filter = $bindable(), onRename, onDelete }: Props = $props();

    let order = $state<NoteOrder>('edited');
    let rows = $derived(sortNotes(shown, order));
    let pinned = $derived(shown.filter((note) => note.pinned));
    let pinnedCount = $derived(notes.filter((note) => note.pinned).length);
    let now = $state(new Date());

    // The note whose sheet is up.
    let sheet = $state<DocumentSummary | null>(null);

    async function togglePin(note: DocumentSummary) {
        sheet = null;
        try {
            await setPinned(note.id, !note.pinned);
        } catch (error) {
            console.error('[notes] could not change the pin:', error);
            toasts.error(note.pinned ? 'Could not unpin this note' : 'Could not pin this note');
        }
    }

    function act(run: (note: DocumentSummary) => void, note: DocumentSummary) {
        sheet = null;
        run(note);
    }
</script>

{#snippet openBadge(note: DocumentSummary)}
    {@const open = openTodos(note)}
    {#if open > 0}
        <span class="badge todo">{open} open</span>
    {/if}
{/snippet}

<div class="phone-notes">
    <div class="m-head">
        <h1 class="m-title">Notes</h1>
        <p class="m-sub">
            {notes.length}
            {notes.length === 1 ? 'note' : 'notes'}{#if pinnedCount > 0}&nbsp;· {pinnedCount} pinned{/if}
        </p>
    </div>

    {#if notes.length > 0}
        <label class="filter">
            <Icon name="search" size={16} />
            <input
                type="search"
                placeholder="Filter by title or #tag"
                bind:value={filter}
                aria-label="Filter notes by title or tag"
            />
        </label>
    {/if}

    {#if pinned.length > 0}
        <h2 class="m-section">Pinned</h2>
        <div class="pinned">
            {#each pinned as note (note.id)}
                <button
                    class="card"
                    onclick={() => openDocument(note.id)}
                    use:longpress={() => (sheet = note)}
                >
                    <span class="card-pin"><Icon name="pin" size={16} /></span>
                    <span class="card-title">{note.title}</span>
                    <span class="grow"></span>
                    {@render openBadge(note)}
                </button>
            {/each}
        </div>
    {/if}

    {#if notes.length === 0}
        <p class="empty-note">
            No notes yet. Press the new note button above to start one, or import Markdown files
            from the menu beside it.
        </p>
    {:else if shown.length === 0}
        <p class="empty-note">No note matches "{filter.trim()}".</p>
    {:else}
        <div class="m-section list-head">
            <h2>All notes</h2>
            <button
                class="order"
                onclick={() => (order = order === 'edited' ? 'created' : 'edited')}
                aria-label="Sort by {order === 'edited' ? 'when made' : 'last edited'}"
            >
                {order === 'edited' ? 'Last edited' : 'Newest'}
                <Icon name="chevron-down" size={14} />
            </button>
        </div>
        <ul class="rows">
            {#each rows as note (note.id)}
                {@const noteTags = tagsOf(tags, note.id)}
                <li>
                    <SwipeRow actionsWidth={156}>
                        {#snippet actions()}
                            <button class="act pin" onclick={() => togglePin(note)}>
                                <Icon name={note.pinned ? 'pin-off' : 'pin'} size={20} />
                                {note.pinned ? 'Unpin' : 'Pin'}
                            </button>
                            <button class="act delete" onclick={() => onDelete(note)}>
                                <Icon name="trash" size={20} />Delete
                            </button>
                        {/snippet}
                        <div class="row" class:empty={!note.has_content}>
                            <button
                                class="row-open"
                                onclick={() => openDocument(note.id)}
                                use:longpress={() => (sheet = note)}
                            >
                                <span class="row-title">{note.title}</span>
                            </button>
                            <span class="row-meta">
                                {#each noteTags as tag (tag)}
                                    <TagPill name={tag} onclick={() => openTag(tag)} />
                                {/each}
                                <span class="when">
                                    {note.has_content
                                        ? editedLabel(note.updated_at, now)
                                        : 'Nothing written yet'}
                                </span>
                            </span>
                            <span class="row-badge">{@render openBadge(note)}</span>
                        </div>
                    </SwipeRow>
                </li>
            {/each}
        </ul>
    {/if}
</div>

{#if sheet}
    {@const note = sheet}
    {@const noteTags = tagsOf(tags, note.id)}
    <ActionSheet label={note.title} onClose={() => (sheet = null)}>
        <div class="sheet-head">
            <span class="tile"><Icon name="note" size={20} /></span>
            <div class="sheet-title">
                <strong>{note.title}</strong>
                <span class="sheet-meta">
                    {@render openBadge(note)}
                    {#each noteTags as tag (tag)}
                        <TagPill name={tag} />
                    {/each}
                </span>
            </div>
        </div>
        <div class="quick">
            <button class="qa" onclick={() => act((n) => openDocument(n.id), note)}>
                <Icon name="open" size={22} />Open
            </button>
            <button class="qa" onclick={() => togglePin(note)}>
                <Icon name={note.pinned ? 'pin-off' : 'pin'} size={22} />
                {note.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button class="qa" onclick={() => act(onRename, note)}>
                <Icon name="edit" size={22} />Rename
            </button>
        </div>
        <div class="more">
            <button class="sa danger" onclick={() => act(onDelete, note)}>
                <Icon name="trash" size={20} />Delete note
            </button>
        </div>
    </ActionSheet>
{/if}

<style>
    .phone-notes {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        /* Clear of the tab bar floating over the foot of the screen. */
        padding-bottom: 104px;
    }

    .filter {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 40px;
        margin: 0 16px 6px;
        padding: 0 12px;
        border-radius: 12px;
        background: var(--bg-secondary);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-muted);
    }

    .filter input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: none;
        color: var(--text-primary);
        font-size: 15px;
    }

    h2.m-section,
    .list-head h2 {
        margin: 0;
    }

    .pinned {
        display: flex;
        gap: 10px;
        padding: 0 16px 6px;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        scroll-padding-inline: 16px;
        scrollbar-width: none;
    }

    .card {
        flex: none;
        width: 152px;
        height: 124px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        padding: 12px;
        border: none;
        border-radius: 16px;
        background: var(--bg-raised);
        box-shadow: 0 0 0 1px var(--border-color);
        color: var(--text-primary);
        text-align: left;
        scroll-snap-align: start;
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
        user-select: none;
    }

    .card-pin {
        color: var(--accent-color);
        display: flex;
    }

    .card-title {
        font-weight: 600;
        font-size: 14px;
        line-height: 19px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .grow {
        flex: 1;
    }

    .list-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .list-head h2 {
        font: inherit;
    }

    .order {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0;
        border: none;
        background: none;
        color: var(--accent-color);
        font-size: 13px;
        font-weight: 550;
    }

    .rows {
        margin: 0;
        padding: 0;
        list-style: none;
        border-top: 1px solid var(--border-color);
    }

    .rows li + li {
        border-top: 1px solid var(--border-color);
    }

    .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        column-gap: 12px;
        min-height: 64px;
        padding: 10px 20px;
    }

    .row-open {
        grid-column: 1;
        padding: 0;
        border: none;
        background: none;
        text-align: left;
        color: var(--text-primary);
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
        user-select: none;
        /* The whole row opens the note, not only its title. */
        position: static;
    }

    .row-open::after {
        content: '';
        position: absolute;
        inset: 0;
    }

    .row-title {
        display: block;
        font-weight: 600;
        font-size: 15.5px;
        line-height: 21px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .row.empty .row-title {
        color: var(--text-muted);
        font-weight: 500;
    }

    .row-meta {
        grid-column: 1;
        position: relative;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
    }

    .when {
        margin-left: 2px;
        font-size: 12.5px;
        color: var(--text-muted);
    }

    .row-badge {
        grid-column: 2;
        grid-row: 1 / span 2;
    }

    .act {
        width: 78px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border: none;
        font-size: 12px;
        font-weight: 600;
    }

    .act.pin {
        background: var(--btn-primary-bg);
        color: var(--on-accent);
    }

    .act.delete {
        background: var(--status-error);
        color: var(--on-danger);
    }

    .empty-note {
        margin: 24px 20px;
        font-size: 14px;
        line-height: 1.6;
        color: var(--text-muted);
    }

    .sheet-head {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 4px 20px 16px;
    }

    .tile {
        width: 44px;
        height: 44px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: 12px;
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .sheet-title {
        min-width: 0;
    }

    .sheet-title strong {
        display: block;
        font-size: 17px;
        font-weight: 650;
        color: var(--text-primary);
    }

    .sheet-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 4px;
    }

    .quick {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        padding: 0 16px 14px;
    }

    .qa {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 76px;
        border: none;
        border-radius: 16px;
        background: var(--bg-secondary);
        box-shadow: inset 0 0 0 1px var(--border-color);
        color: var(--text-primary);
        font-size: 13px;
        font-weight: 550;
    }

    .qa :global(.icon) {
        color: var(--accent-color);
    }

    .more {
        margin: 0 16px;
        border-radius: 16px;
        background: var(--bg-secondary);
        box-shadow: inset 0 0 0 1px var(--border-color);
        overflow: hidden;
    }

    .sa {
        display: flex;
        align-items: center;
        gap: 14px;
        width: 100%;
        height: 52px;
        padding: 0 20px;
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 16px;
    }

    .sa.danger {
        color: var(--error-text);
    }
</style>
