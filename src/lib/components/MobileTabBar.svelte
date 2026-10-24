<script lang="ts">
    import { page } from '$app/state';
    import { appStore, documents } from '$lib/stores/app';
    import { openJournal } from '$lib/services/journals';
    import { openNotes, openSearch, openTodos } from '$lib/services/navigation';
    import { journalTitleFor } from '$lib/calendar/calendar';
    import { toasts } from '$lib/services/toast';
    import type { DocumentSummary } from '$lib/types';
    import Icon, { type IconName } from './Icon.svelte';

    // On a phone, the four places visited most, under the thumb. Everything
    // else is in the drawer, the same sidebar the desktop has.

    let path = $derived(page.url.pathname);
    let todayTitle = $derived(journalTitleFor(new Date()));
    let onToday = $derived(
        page.route.id === '/doc/[id]' && $appStore.currentDocument?.title === todayTitle,
    );
    let openCount = $derived(
        $documents.reduce(
            (n: number, d: DocumentSummary) => n + (d.todo_count - d.completed_todo_count),
            0,
        ),
    );

    async function goToday() {
        try {
            await openJournal(todayTitle);
        } catch (error) {
            console.error('[tabs] could not open today', error);
            toasts.error("Could not open today's journal");
        }
    }

    let tabs = $derived<{ label: string; icon: IconName; on: boolean; go: () => unknown }[]>([
        { label: 'Today', icon: 'today', on: onToday, go: goToday },
        { label: 'Notes', icon: 'notes', on: path === '/notes', go: openNotes },
        { label: 'Todos', icon: 'todos', on: path === '/todos', go: openTodos },
        { label: 'Search', icon: 'search', on: path === '/search', go: openSearch },
    ]);
</script>

<nav class="tab-bar" aria-label="Main">
    {#each tabs as tab (tab.label)}
        <button
            class="tab"
            class:on={tab.on}
            aria-current={tab.on ? 'page' : undefined}
            onclick={() => tab.go()}
        >
            <Icon name={tab.icon} size={22} />
            {tab.label}
            {#if tab.label === 'Todos' && openCount > 0 && !tab.on}
                <span class="tab-count" aria-label="{openCount} open">{openCount}</span>
            {/if}
        </button>
    {/each}
</nav>

<style>
    /* A pill floating over the foot of the page, rather than a bar welded to
       it, so the page reads to the bottom edge behind it. */
    .tab-bar {
        position: fixed;
        z-index: 100;
        left: calc(var(--safe-left) + 14px);
        right: calc(var(--safe-right) + 14px);
        bottom: calc(var(--safe-bottom) + 14px);
        height: 64px;
        padding: 6px;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
        border-radius: 24px;
        background: var(--bg-raised);
        box-shadow: var(--shadow-pop);
    }

    /* Out of the way while writing, when the formatting bar sits above the
       keyboard where this would be. */
    :global(body:has(.toolbar)) .tab-bar {
        display: none;
    }

    .tab {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        border: none;
        border-radius: 18px;
        background: none;
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 550;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }

    .tab.on {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .tab-count {
        position: absolute;
        top: 3px;
        left: 50%;
        margin-left: 6px;
        min-width: 18px;
        height: 16px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--todo-open);
        color: var(--on-accent);
        font-size: 10px;
        font-weight: 650;
        line-height: 16px;
        text-align: center;
    }
</style>
