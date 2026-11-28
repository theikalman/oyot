<script lang="ts">
    import { indexRevision } from '$lib/stores/derivedIndex';
    import { openTag } from '$lib/services/navigation';
    import { createTagIndex } from '$lib/tags/tagStore.svelte';
    import type { TagSummary } from '$lib/tiptap/tags';
    import WorkspaceShell from '$lib/components/WorkspaceShell.svelte';
    import { tagHueStyle } from '$lib/tags/tagHue';
    import { sortTags, TAG_ORDER_LABELS, TAG_ORDERS } from '$lib/tags/tagOrder';
    import { tagOrder } from '$lib/tags/tagOrder.svelte';

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
        sortTags(
            tags.tags.filter((tag: TagSummary) => tag.name.includes(filter.trim().toLowerCase())),
            tagOrder.value,
        ),
    );

    function usage(tag: TagSummary): string {
        return tag.documentCount === 1 ? '1 note' : `${tag.documentCount} notes`;
    }
</script>

<WorkspaceShell title="Tags">
    <div class="tags page-body">
        <div class="page-bar">
            <p class="page-summary">
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
                <div class="page-actions">
                    <input
                        class="field-input"
                        type="search"
                        placeholder="Filter tags"
                        bind:value={filter}
                        aria-label="Filter tags"
                    />
                    <label class="sort">
                        Sort by
                        <select class="field-input" bind:value={tagOrder.value}>
                            {#each TAG_ORDERS as order (order)}
                                <option value={order}>{TAG_ORDER_LABELS[order]}</option>
                            {/each}
                        </select>
                    </label>
                </div>
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
                        <button
                            class="tag-row"
                            style={tagHueStyle(tag.name)}
                            onclick={() => openTag(tag.name)}
                        >
                            <span class="tag-name"><span class="hash">#</span>{tag.name}</span>
                            <span class="tag-usage">{usage(tag)}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</WorkspaceShell>

<style>
    .sort {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .sort select {
        min-width: 0;
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
        font-family: var(--font-mono);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
    }

    .tag-list {
        max-width: 720px;
        margin: 8px -12px 0;
        padding: 0;
        list-style: none;
    }

    .tag-row {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        height: 32px;
        padding: 0 12px;
        text-align: left;
        background: transparent;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        color: var(--text-primary);
        font-size: 14px;
    }

    .tag-row:hover {
        background: var(--bg-hover);
    }

    .tag-name {
        flex: 1;
        min-width: 0;
        font-weight: 550;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .hash {
        color: var(--tag-hue, var(--tag-1));
        font-weight: 700;
        margin-right: 2px;
    }

    .tag-usage {
        flex-shrink: 0;
        min-width: 56px;
        text-align: right;
        font-size: 12.5px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
    }
</style>
