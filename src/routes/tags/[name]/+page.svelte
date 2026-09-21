<script lang="ts">
    import { page } from '$app/state';
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openDocument, openTags } from '$lib/services/navigation';
    import { formatJournalTitle } from '$lib/calendar/calendar';
    import { createTaggedDocuments } from '$lib/tags/tagStore.svelte';
    import { normalizeTagName } from '$lib/tiptap/tags';
    import type { DocumentSummary } from '$lib/types';
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

    .link-btn {
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
</style>
