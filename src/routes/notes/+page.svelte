<script lang="ts">
    import { documents } from '$lib/stores/app';
    import { openDocument } from '$lib/services/navigation';
    import { filterNotes, notesOf, noteStatus } from '$lib/notes/noteIndex';
    import type { DocumentSummary } from '$lib/types';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import PinToggle from '$lib/components/PinToggle.svelte';
    import NewNoteDialog from '$lib/components/NewNoteDialog.svelte';
    import RenameNoteDialog from '$lib/components/RenameNoteDialog.svelte';
    import DeleteNoteDialog from '$lib/components/DeleteNoteDialog.svelte';

    // Every note, on one page, with what can be done to one: open it, pin it
    // to the sidebar, rename it, delete it.
    //
    // Read from the document store rather than queried, as the journal index
    // is. Everything a row shows is already kept current there by the save,
    // merge and pin paths, so a peer's rename or pin moves this page as well.
    let notes = $derived(notesOf($documents));
    let pinnedCount = $derived(notes.filter((note: DocumentSummary) => note.pinned).length);

    // Filtered here rather than by querying: the whole list is already in
    // hand, and one person's notes are not a corpus worth paging.
    let filter = $state('');
    let shown = $derived(filterNotes(notes, filter));

    let creating = $state(false);
    let renaming = $state<DocumentSummary | null>(null);
    let deleting = $state<DocumentSummary | null>(null);

    // Which row's menu is open, held here so only one is at a time.
    let openMenuId = $state<string | null>(null);

    function toggleMenu(id: string) {
        openMenuId = openMenuId === id ? null : id;
    }

    function handleWindowClick(e: MouseEvent) {
        const target = e.target as HTMLElement;
        if (!target.closest('.row-menu-btn') && !target.closest('.row-menu')) {
            openMenuId = null;
        }
    }

    function startRename(note: DocumentSummary) {
        renaming = note;
        openMenuId = null;
    }

    function startDelete(note: DocumentSummary) {
        deleting = note;
        openMenuId = null;
    }
</script>

<svelte:window onclick={handleWindowClick} />

<WorkspaceShell title="Notes">
    <div class="notes">
        <div class="notes-bar">
            <p class="summary">
                {notes.length}
                {notes.length === 1 ? 'note' : 'notes'}{#if pinnedCount > 0}, {pinnedCount} pinned{/if}
            </p>
            <div class="bar-actions">
                {#if notes.length > 0}
                    <input
                        class="filter"
                        type="search"
                        placeholder="Filter notes"
                        bind:value={filter}
                        aria-label="Filter notes"
                    />
                {/if}
                <button class="action-btn" onclick={() => (creating = true)}>New note</button>
            </div>
        </div>

        {#if notes.length === 0}
            <p class="note">No notes yet. Press New note to start one.</p>
        {:else if shown.length === 0}
            <p class="note">No note matches "{filter.trim()}".</p>
        {:else}
            <ul class="note-list">
                {#each shown as note (note.id)}
                    <!-- The row is the container, not the button: the pin and
                         the menu are buttons of their own, and one button
                         cannot hold another. -->
                    <li class="note-row" class:empty={!note.has_content}>
                        <button
                            class="note-open"
                            onclick={() => openDocument(note.id)}
                            title="Open {note.title}"
                        >
                            <span class="note-title">{note.title}</span>
                            <span class="note-status">{noteStatus(note)}</span>
                        </button>
                        <PinToggle docId={note.id} pinned={note.pinned} />
                        <div class="row-menu-anchor">
                            <button
                                class="row-menu-btn"
                                onclick={() => toggleMenu(note.id)}
                                title="Note options"
                                aria-label="Note options"
                                aria-expanded={openMenuId === note.id}
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
                                    aria-hidden="true"
                                    ><circle cx="5" cy="12" r="1" /><circle
                                        cx="12"
                                        cy="12"
                                        r="1"
                                    /><circle cx="19" cy="12" r="1" /></svg
                                >
                            </button>
                            {#if openMenuId === note.id}
                                <div class="row-menu">
                                    <button class="row-menu-item" onclick={() => startRename(note)}>
                                        Rename
                                    </button>
                                    <button
                                        class="row-menu-item danger"
                                        onclick={() => startDelete(note)}
                                    >
                                        Delete
                                    </button>
                                </div>
                            {/if}
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</WorkspaceShell>

{#if creating}
    <NewNoteDialog onClose={() => (creating = false)} />
{/if}

{#if renaming}
    <RenameNoteDialog doc={renaming} onClose={() => (renaming = null)} />
{/if}

{#if deleting}
    <DeleteNoteDialog doc={deleting} onClose={() => (deleting = null)} />
{/if}

<style>
    .notes {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 32px;
    }

    .notes-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 8px;
    }

    .summary {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .bar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .filter {
        padding: 5px 10px;
        font-size: 13px;
        font-family: inherit;
        color: var(--text-primary);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        min-width: 160px;
    }

    .filter:focus {
        outline: none;
        border-color: var(--accent-color);
    }

    .action-btn {
        padding: 5px 10px;
        font-family: inherit;
        font-size: 13px;
        color: var(--text-primary);
        background: transparent;
        border: 1px solid var(--border-color);
        border-radius: 4px;
        cursor: pointer;
    }

    .action-btn:hover {
        background: var(--bg-hover);
    }

    .note {
        margin: 24px 0;
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .note-list {
        margin: 12px 0 0 0;
        padding: 0;
        list-style: none;
    }

    .note-row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 4px 0 8px;
        border-radius: 4px;
    }

    .note-row:hover {
        background: var(--bg-hover);
    }

    .note-open {
        display: flex;
        align-items: baseline;
        gap: 12px;
        flex: 1;
        min-width: 0;
        padding: 9px 0;
        text-align: left;
        background: transparent;
        border: none;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
    }

    .note-title {
        flex: 1;
        min-width: 0;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .note-row.empty .note-title {
        color: var(--text-muted);
        font-weight: 400;
    }

    .note-status {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-muted);
    }

    .row-menu-anchor {
        position: relative;
        flex-shrink: 0;
    }

    .row-menu-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
    }

    .row-menu-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .row-menu {
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

    .row-menu-item {
        text-align: left;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
        font-family: inherit;
        color: var(--text-primary);
    }

    .row-menu-item:hover {
        background: var(--bg-hover);
    }

    .row-menu-item.danger {
        color: #ef4444;
    }

    /* On a phone the title and what it says about itself do not fit side by
       side, so the status goes under the title rather than squeezing it. */
    @media (max-width: 640px) {
        .notes {
            padding: 12px 16px 24px;
        }

        .note-open {
            flex-direction: column;
            align-items: stretch;
            gap: 2px;
        }

        .note-status:empty {
            display: none;
        }
    }
</style>
