<script lang="ts">
    import { page } from '$app/state';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocument, openTag, openTags } from '$lib/services/navigation';
    import { formatJournalTitle } from '$lib/calendar/calendar';
    import { createTaggedDocuments } from '$lib/tags/tagStore.svelte';
    import { loadAllTags, renameTag, TagRenameError } from '$lib/services/tags';
    import { normalizeTagName } from '$lib/tiptap/tags';
    import { toasts } from '$lib/services/toast';
    import type { DocumentSummary } from '$lib/types';
    import Modal from '$lib/components/Modal.svelte';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // The tag this page is about comes from the URL, normalized on the way in.
    // A link typed or shared with the wrong case still lands on the one page
    // the tag has, because a tag has one spelling (ADR 0019).
    let name = $derived(normalizeTagName(page.params.name ?? ''));

    const tagged = createTaggedDocuments();

    // Reloaded on every change to any document's derived rows, and whenever the
    // URL names a different tag.
    $effect(() => {
        void $indexRevision;
        void tagged.load(name);
    });

    // Held in state rather than read at render time, so a page left open
    // overnight stops calling yesterday's journal "Today".
    let today = $state(new Date());

    $effect(() => {
        const refresh = () => {
            const now = new Date();
            if (now.toDateString() !== today.toDateString()) today = now;
        };
        const timer = setInterval(refresh, 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    });

    function heading(doc: DocumentSummary): string {
        return doc.doc_type === 'journal' ? formatJournalTitle(doc.title, today) : doc.title;
    }

    let renaming = $state(false);
    let renameValue = $state('');
    let renameError = $state('');
    let renameBusy = $state(false);

    function startRename() {
        renameValue = name;
        renameError = '';
        renaming = true;
    }

    function closeRename() {
        if (renameBusy) return;
        renaming = false;
        renameError = '';
    }

    // Every other tag there is, so the dialog can say when a rename would merge
    // two tags together rather than just move one. Loaded when the dialog
    // opens, not with the page: it is needed for a warning, not for the list.
    let existingTags = $state<string[]>([]);

    $effect(() => {
        if (!renaming) return;
        let live = true;
        void loadAllTags().then((tags) => {
            if (live) existingTags = tags.map((tag) => tag.name);
        });
        return () => {
            live = false;
        };
    });

    // What the rename would actually write, shown before it is run: the name is
    // normalized, so "Deep Work" becomes "deep work", and a user who is not
    // told that reads it as the app having mangled their typing.
    let renamePreview = $derived(normalizeTagName(renameValue));
    let mergesInto = $derived(
        renamePreview !== '' && renamePreview !== name && existingTags.includes(renamePreview),
    );

    async function confirmRename() {
        if (renameBusy) return;
        renameBusy = true;
        renameError = '';
        try {
            const result = await renameTag(name, renameValue);
            renaming = false;
            if (result.documents === 0) {
                toasts.info(`No note mentions #${result.from} any more.`);
            } else {
                const notes = result.documents === 1 ? 'note' : 'notes';
                toasts.success(
                    `Renamed #${result.from} to #${result.to} in ${result.documents} ${notes}.`,
                );
            }
            if (result.failed > 0) {
                const left = result.failed === 1 ? 'note' : 'notes';
                toasts.error(`#${result.from} could not be changed in ${result.failed} ${left}.`);
            }
            // The page is about a tag that no longer exists under this name.
            await openTag(result.to);
        } catch (error) {
            // A rule the user broke (an empty name, the name it already has) is
            // theirs to fix, so it stays in the dialog. Anything else is ours,
            // and the console has the detail.
            if (error instanceof TagRenameError) {
                renameError = error.message;
            } else {
                console.error('[tags] rename failed:', error);
                renameError = 'Could not rename the tag. Nothing else was changed.';
            }
        } finally {
            renameBusy = false;
        }
    }
</script>

<WorkspaceShell title={`#${name}`}>
    <div class="tag-page">
        <div class="tag-bar">
            <p class="summary">
                {#if tagged.loading && tagged.isEmpty}
                    Looking for notes...
                {:else if tagged.failed}
                    &nbsp;
                {:else}
                    {tagged.documents.length}
                    {tagged.documents.length === 1 ? 'note' : 'notes'} mention this tag
                {/if}
            </p>
            <div class="actions">
                <button class="link-btn" onclick={() => openTags()}>All tags</button>
                <button class="action-btn" onclick={startRename}>Rename</button>
            </div>
        </div>

        {#if tagged.failed}
            <p class="note error">
                Could not read the notes for this tag right now. They are unchanged.
            </p>
        {:else if tagged.loading && tagged.isEmpty}
            <p class="note">Loading...</p>
        {:else if tagged.isEmpty}
            <p class="note">
                Nothing mentions <code>#{name}</code> any more. A tag exists for as long as a note carries
                it, so this one is gone once you leave the page.
            </p>
        {:else}
            {#each [{ label: 'Journals', docs: tagged.journals }, { label: 'Notes', docs: tagged.notes }] as section (section.label)}
                {#if section.docs.length > 0}
                    <section class="section">
                        <h2 class="section-title">{section.label}</h2>
                        <ul class="doc-list">
                            {#each section.docs as doc (doc.id)}
                                <li>
                                    <button
                                        class="doc"
                                        onclick={() => openDocument(doc.id)}
                                        title="Open {doc.title}"
                                    >
                                        <span class="doc-title">{heading(doc)}</span>
                                        {#if doc.todo_count > 0}
                                            <span class="doc-meta">
                                                {doc.todo_count - doc.completed_todo_count} open
                                            </span>
                                        {/if}
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/if}
            {/each}
        {/if}

        <p class="footnote">
            A tag cannot be deleted, because there is no list of tags to delete it from. Remove the
            chip from the notes above and the tag goes with it.
        </p>
    </div>
</WorkspaceShell>

{#if renaming}
    <Modal title={`Rename #${name}`} onClose={closeRename}>
        <input
            type="text"
            bind:value={renameValue}
            placeholder="New name..."
            class="modal-input"
            onkeydown={(e) => e.key === 'Enter' && confirmRename()}
        />
        <p class="modal-hint">
            {#if renamePreview && renamePreview !== renameValue.trim()}
                This will be stored as <strong>#{renamePreview}</strong>. Tags have one spelling.
            {:else}
                Every note that mentions #{name} will be changed.
            {/if}
        </p>
        {#if mergesInto}
            <p class="modal-hint warn">#{renamePreview} already exists. The two will merge.</p>
        {/if}
        {#if renameError}
            <p class="modal-error">{renameError}</p>
        {/if}
        {#snippet actions()}
            <button class="modal-btn secondary" data-secondary onclick={closeRename}>Cancel</button>
            <button class="modal-btn" onclick={confirmRename} disabled={renameBusy}>
                {renameBusy ? 'Renaming...' : 'Rename'}
            </button>
        {/snippet}
    </Modal>
{/if}

<style>
    .tag-page {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 32px;
    }

    .tag-bar {
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

    .actions {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .link-btn,
    .action-btn {
        font-family: inherit;
        font-size: 13px;
        cursor: pointer;
        border-radius: 4px;
        padding: 5px 10px;
    }

    .link-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
    }

    .link-btn:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
    }

    .action-btn {
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-primary);
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

    .note.error {
        color: var(--status-error);
    }

    .note code {
        background: var(--code-bg);
        color: var(--text-primary);
        padding: 1px 5px;
        border-radius: 3px;
    }

    .footnote {
        margin: 32px 0 0 0;
        padding-top: 12px;
        border-top: 1px solid var(--border-color);
        font-size: 12px;
        color: var(--text-muted);
        line-height: 1.6;
    }

    .section {
        margin-top: 20px;
    }

    .section-title {
        margin: 0 0 4px 0;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }

    .doc-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .doc {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        padding: 8px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
    }

    .doc:hover {
        background: var(--bg-hover);
    }

    .doc-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .doc-meta {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-muted);
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

    .modal-hint {
        margin: 10px 0 0 0;
        font-size: 13px;
        color: var(--text-secondary);
        line-height: 1.4;
    }

    .modal-hint.warn {
        color: var(--status-pending);
    }

    .modal-error {
        margin: 10px 0 0 0;
        font-size: 13px;
        color: var(--status-error);
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

    .modal-btn:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .modal-btn.secondary {
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
    }

    .modal-btn.secondary:hover {
        background: var(--bg-hover);
    }
</style>
