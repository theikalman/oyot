<script lang="ts" module>
    export interface PopupItem {
        id: string;
        title: string;
        icon?: string;
        /** A second, quieter line: what the row is, beyond its name. */
        subtitle?: string;
    }
</script>

<script lang="ts">
    import type { Writable } from 'svelte/store';

    // Both are stores rather than plain props, so the extension can mount this
    // once and update it, instead of mounting a replacement on every keystroke.
    interface Props {
        items: Writable<PopupItem[]>;
        selectedIndex: Writable<number>;
        onCommand: (id: string) => void;
        /**
         * What the user has typed to narrow the list, when the caller supports
         * filtering. Shown above the results so there is some sign of what is
         * being filtered by; the caret is still in the editor.
         */
        queryLabel?: Writable<string>;
        /**
         * What to say when there are no rows. The default answers "did my
         * filter match anything"; a caller whose empty list means something
         * else (nothing to list yet, type to make one) says so instead.
         */
        emptyLabel?: string;
    }

    let {
        items,
        selectedIndex,
        onCommand,
        queryLabel,
        emptyLabel = 'No results',
    }: Props = $props();

    let listElement: HTMLUListElement | undefined = $state();

    $effect(() => {
        if (listElement && $selectedIndex >= 0) {
            const selectedItem = listElement.children[$selectedIndex] as HTMLElement;
            selectedItem?.scrollIntoView({ block: 'nearest' });
        }
    });
</script>

<div class="suggestion-popup">
    {#if queryLabel && $queryLabel}
        <div class="suggestion-query">Filtering: {$queryLabel}</div>
    {/if}
    {#if $items.length === 0}
        <div class="suggestion-empty">{emptyLabel}</div>
    {:else}
        <ul class="suggestion-list" bind:this={listElement}>
            {#each $items as item, index (item.id)}
                <li
                    class="suggestion-item"
                    class:selected={index === $selectedIndex}
                    role="option"
                    aria-selected={index === $selectedIndex}
                    onmouseenter={() => selectedIndex.set(index)}
                    onclick={() => onCommand(item.id)}
                    onkeydown={(e) => {
                        if (e.key === 'Enter') onCommand(item.id);
                    }}
                >
                    <!--
                        Icons are inline SVG constants declared in
                        src/lib/tiptap/commands/; they never carry user or peer
                        content. Keep it that way: anything data-derived here
                        must be rendered as text, not html.
                      -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    <span class="item-icon">{@html item.icon || '📄'}</span>
                    <span class="item-content">
                        <span class="item-title">{item.title}</span>
                        {#if item.subtitle}
                            <span class="item-subtitle">{item.subtitle}</span>
                        {/if}
                    </span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .suggestion-query {
        padding: 6px 12px;
        font-size: 12px;
        color: var(--text-muted);
        border-bottom: 1px solid var(--border-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .suggestion-popup {
        position: fixed;
        z-index: 1000;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        min-width: 280px;
        max-width: 400px;
        max-height: 320px;
        overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .suggestion-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
    }

    .suggestion-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        cursor: pointer;
        transition: background-color 0.1s;
    }

    .suggestion-item:hover,
    .suggestion-item.selected {
        background-color: var(--bg-hover);
    }

    .suggestion-item.selected {
        background-color: var(--accent-bg);
    }

    .item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
    }

    .item-icon :global(svg) {
        width: 20px;
        height: 20px;
    }

    .item-content {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .item-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .item-subtitle {
        font-size: 12px;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .suggestion-empty {
        padding: 16px;
        text-align: center;
        color: var(--text-secondary);
        font-size: 14px;
    }
</style>
