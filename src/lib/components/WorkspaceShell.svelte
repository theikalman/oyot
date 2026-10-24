<script lang="ts">
    import type { Snippet } from 'svelte';
    import { isLoading } from '$lib/stores/app';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import Sidebar, { isSmallScreen, startsCollapsed } from './Sidebar.svelte';
    import PageTitle from './PageTitle.svelte';
    import SyncStatus from './SyncStatus.svelte';
    import Icon from './Icon.svelte';

    // The chrome every workspace route shares: the sidebar beside a titled
    // column with the sync indicator in its header. Extracted when the todo
    // index became the second route to need exactly this, rather than copied
    // and left to drift.
    interface Props {
        title?: string | null;
        /** Controls that belong to the title, such as pinning the open note. */
        actions?: Snippet;
        /** Controls for the page as a whole, beside the sync indicator. */
        tools?: Snippet;
        children: Snippet;
    }

    let { title = null, actions, tools, children }: Props = $props();

    // Held here rather than in the sidebar, so the button that shows and
    // hides the sidebar can sit in this header. It used to float over the
    // bottom left of the page, on top of the start of whatever lines were
    // there, which on a phone with the keyboard up are the ones being typed.
    // A page starts with it as the last page left it on a wide screen.
    let sidebarCollapsed = $state(startsCollapsed());
    let sidebarToggle = $state<HTMLButtonElement | null>(null);

    // The sidebar's keys do what the button does, wherever focus is on the
    // page. Not while a dialog is open, and once for a key held down rather
    // than a flicker. Hidden while the keys are in it, the sidebar hands
    // focus to the button, rather than leaving it nowhere.
    function handleKeydown(event: KeyboardEvent) {
        if (!customShortcuts.matches('sidebar', event)) return;
        event.preventDefault();
        if (event.repeat || document.querySelector('[aria-modal="true"]')) return;
        const focusInside = document.getElementById('sidebar')?.contains(document.activeElement);
        sidebarCollapsed = !sidebarCollapsed;
        if (sidebarCollapsed && focusInside) sidebarToggle?.focus();
    }

    // Named with its keys in the tooltip, the way the Edit button is.
    let toggleKeys = $derived(customShortcuts.labelFor('sidebar'));
    let toggleHint = $derived(
        `${sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}${toggleKeys ? ` (${toggleKeys})` : ''}`,
    );

    // How tall this header is. On a small screen the sidebar opens over the
    // page, and it opens below this, so the button that closes it is still
    // there to press. Measured rather than assumed: a title shown in full
    // makes the header taller.
    let headerHeight = $state(57);

    // On a phone the toggle is a menu button that opens the drawer.
    let small = $state(isSmallScreen());
    $effect(() => {
        const mq = window.matchMedia('(max-width: 768px)');
        const onChange = (e: MediaQueryListEvent) => (small = e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="app" style:--workspace-header-height="{headerHeight}px">
    <div class="workspace">
        <Sidebar bind:collapsed={sidebarCollapsed} />
        <div class="main-content" class:flush={sidebarCollapsed || small}>
            <div class="sync-status-container" bind:offsetHeight={headerHeight}>
                <div class="page-start">
                    <!-- Brings the sidebar back, or opens it as a drawer on a
                         phone. While the sidebar is out, its own button hides
                         it again, so this one is not needed. -->
                    {#if sidebarCollapsed}
                        <button
                            class="sidebar-toggle"
                            bind:this={sidebarToggle}
                            onclick={() => (sidebarCollapsed = false)}
                            title={toggleHint}
                            aria-label="Sidebar"
                            aria-expanded={false}
                            aria-controls="sidebar"
                        >
                            <Icon name={small ? 'menu' : 'panel-left'} size={20} />
                        </button>
                    {/if}
                    {#if title}
                        <div class="page-heading">
                            <PageTitle {title} />
                            {#if actions}
                                <div class="title-actions">{@render actions()}</div>
                            {/if}
                        </div>
                    {/if}
                </div>
                <div class="page-tools">
                    {@render tools?.()}
                    <!-- The sidebar's foot says how sync stands; with the
                         sidebar away, the header does. -->
                    {#if sidebarCollapsed}
                        <SyncStatus />
                    {/if}
                </div>
            </div>
            {@render children()}
        </div>
    </div>

    {#if $isLoading}
        <div class="loading-overlay">
            <div class="loading-spinner"></div>
            <p>Loading...</p>
        </div>
    {/if}
</main>

<style>
    .app {
        /* The body's safe-area padding already takes this much of the screen. */
        height: calc(100dvh - var(--safe-top) - var(--safe-bottom));
        display: flex;
        flex-direction: column;
    }

    .workspace {
        flex: 1;
        display: flex;
        overflow: hidden;
        background: var(--bg-secondary);
    }

    /* The sheet: every page sits on it, raised over the frame, so where you
       read and write is always the brightest, calmest surface. */
    .main-content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        margin: 8px 8px 8px 0;
        background: var(--bg-primary);
        border-radius: var(--radius-sheet);
        box-shadow: var(--shadow-sheet);
    }

    /* Without the sidebar beside it, the sheet keeps the same margin all
       round. */
    .main-content.flush {
        margin-left: 8px;
    }

    /* A phone has no room for a frame: the sheet is the screen. */
    @media (max-width: 768px) {
        .main-content {
            margin: 0 !important;
            border-radius: 0;
            box-shadow: none;
        }
    }

    /* Everything in the header lines up with the first line of the title,
       in a row 32px high, rather than with the middle of however many lines
       the title takes. Shown in full, a long title runs on down past its
       buttons instead of taking them to its middle, so they stay where they
       are while it opens and closes. */
    .sync-status-container {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-color);
        min-height: 52px;
    }

    .page-start {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
    }

    .page-heading {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
    }

    .title-actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        height: 32px;
    }

    /* A journal has no pin, and an empty row would still take a gap. */
    .title-actions:empty {
        display: none;
    }

    /* 32px, the height of every row in this header. */
    .sidebar-toggle {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 0;
        background: none;
        border: none;
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    @media (hover: hover) {
        .sidebar-toggle:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
    }

    /* Sized for a finger: what a tap can land on is 44px square, the least
       Apple's guidelines allow, reaching into the header's padding and the
       gap before the title without the button looking any bigger. */
    @media (pointer: coarse) {
        .sidebar-toggle {
            position: relative;
            -webkit-tap-highlight-color: transparent;
        }

        .sidebar-toggle::after {
            content: '';
            position: absolute;
            inset: -6px;
        }
    }

    .page-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        height: 32px;
    }

    .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--loading-overlay-bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 4px solid var(--border-color);
        border-top: 4px solid var(--accent-color);
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .loading-overlay p {
        margin-top: 16px;
        color: var(--text-secondary);
    }
</style>
