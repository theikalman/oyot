<script lang="ts">
    import type { Writable } from 'svelte/store';

    interface Props {
        items: Array<{ id: string; title: string; icon?: string }>;
        selectedIndexStore: Writable<number>;
        command: (item: { id: string; title: string; icon?: string }) => void;
        onClose: () => void;
    }

    let { items, selectedIndexStore, command, onClose }: Props = $props();

    let listElement: HTMLUListElement | undefined = $state();

    $effect(() => {
        if (listElement && $selectedIndexStore >= 0) {
            const selectedItem = listElement.children[$selectedIndexStore] as HTMLElement;
            if (selectedItem) {
                selectedItem.scrollIntoView({ block: 'nearest' });
            }
        }
    });
</script>

<div class="suggestion-popup">
    {#if items.length === 0}
        <div class="suggestion-empty">No results</div>
    {:else}
        <ul class="suggestion-list" bind:this={listElement}>
            {#each items as item, index}
                <li
                    class="suggestion-item"
                    class:selected={index === $selectedIndexStore}
                    role="option"
                    aria-selected={index === $selectedIndexStore}
                    onmouseenter={() => { selectedIndexStore.set(index); }}
                    onclick={() => command(item)}
                    onkeydown={(e) => { if (e.key === 'Enter') command(item); }}
                >
                    <span class="item-icon">{item.icon || '📄'}</span>
                    <span class="item-content">
                        <span class="item-title">{item.title}</span>
                    </span>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
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
        font-size: 18px;
        flex-shrink: 0;
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

    .suggestion-empty {
        padding: 16px;
        text-align: center;
        color: var(--text-secondary);
        font-size: 14px;
    }
</style>;
