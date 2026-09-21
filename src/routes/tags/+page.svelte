<script lang="ts">
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openTag } from '$lib/services/navigation';
    import { createTagIndex } from '$lib/tags/tagStore.svelte';
    import type { TagSummary } from '$lib/tiptap/tags';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';

    // Every tag any note or journal carries, on one page.
    //
    // The rows come from SQL, not from the documents: content lives in the
    // CRDT, and the indexer records a document's tags as it is written or
    // merged (see src/lib/editor/documentIndex.ts). That is what makes this
    // page cover documents this device has only ever received.
    const tags = createTagIndex();

    // Reloaded on every change to any document's derived rows: a tag added
    // here, a tag added on another route, a rename, a delete, a peer's edit
    // arriving while this page is open.
    $effect(() => {
        void $indexRevision;
        void tags.load();
    });

    let filter = $state('');

    // Filtered here rather than by re-querying: the whole list is already in
    // hand, and one person's tags are not a corpus worth paging.
    let shown = $derived(
        tags.tags.filter((tag: TagSummary) => tag.name.includes(filter.trim().toLowerCase())),
    );

    function usage(tag: TagSummary): string {
        return tag.documentCount === 1 ? '1 note' : `${tag.documentCount} notes`;
    }
</script>

<WorkspaceShell title="Tags">
    <div class="tags">
        <div class="tags-bar">
            <p class="summary">
                {#if tags.loading && tags.isEmpty}
                    Collecting your tags...
                {:else if tags.failed}
                    &nbsp;
                {:else}
                    {tags.tags.length}
                    {tags.tags.length === 1 ? 'tag' : 'tags'}
                {/if}
            </p>
            {#if !tags.isEmpty}
                <input
                    class="filter"
                    type="search"
                    placeholder="Filter tags"
                    bind:value={filter}
                    aria-label="Filter tags"
                />
            {/if}
        </div>

        {#if tags.failed}
            <p class="note error">
                Could not read your tags right now. They are still in your notes.
            </p>
        {:else if tags.loading && tags.isEmpty}
            <p class="note">Loading...</p>
        {:else if tags.isEmpty}
            <p class="note">
                No tags yet. Type <code>/tag</code> in any note or journal and it will show up here.
            </p>
        {:else if shown.length === 0}
            <p class="note">No tag matches "{filter}".</p>
        {:else}
            <ul class="tag-list">
                {#each shown as tag (tag.name)}
                    <li>
                        <button class="tag-row" onclick={() => openTag(tag.name)}>
                            <span class="tag-name">#{tag.name}</span>
                            <span class="tag-usage">{usage(tag)}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</WorkspaceShell>

<style>
    .tags {
        flex: 1;
        overflow-y: auto;
        padding: 16px 24px 32px;
    }

    .tags-bar {
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

    .tag-list {
        margin: 12px 0 0 0;
        padding: 0;
        list-style: none;
    }

    .tag-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        padding: 9px 8px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
    }

    .tag-row:hover {
        background: var(--bg-hover);
    }

    .tag-name {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tag-usage {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--text-muted);
    }
</style>
