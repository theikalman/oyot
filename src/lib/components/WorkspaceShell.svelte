<script lang="ts">
    import type { Snippet } from 'svelte';
    import { isLoading } from '$lib/stores/app';
    import Sidebar, { isSmallScreen } from './Sidebar.svelte';
    import PageTitle from './PageTitle.svelte';
    import SyncStatus from './SyncStatus.svelte';

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

    // Held here rather than in the sidebar, so the button that brings the
    // sidebar back can sit in this header. It used to float over the bottom
    // left of the page, on top of the start of whatever lines were there,
    // which on a phone with the keyboard up are the ones being typed.
    let sidebarCollapsed = $state(isSmallScreen());
</script>

<main class="app">
    <div class="workspace">
        <Sidebar bind:collapsed={sidebarCollapsed} />
        <div class="main-content">
            <div class="sync-status-container">
                <div class="page-start">
                    {#if sidebarCollapsed}
                        <button
                            class="show-sidebar-btn"
                            onclick={() => (sidebarCollapsed = false)}
                            title="Show sidebar"
                            aria-label="Show sidebar"
                        >
                            <svg
                                width="20"
                                height="20"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                aria-hidden="true"
                                ><path
                                    stroke="currentColor"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="m13 17 5-5-5-5M6 17l5-5-5-5"
                                /></svg
                            >
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
                    <SyncStatus />
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
    }

    .main-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-primary);
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
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color);
        min-height: 57px;
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

    /* The same size as the « beside the sidebar's search box, which puts the
       sidebar away again. */
    .show-sidebar-btn {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 0;
        background: none;
        border: none;
        border-radius: 4px;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    @media (hover: hover) {
        .show-sidebar-btn:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
        }
    }

    /* Sized for a finger: what a tap can land on is 44px square, the least
       Apple's guidelines allow, reaching into the header's padding and the
       gap before the title without the button looking any bigger. */
    @media (pointer: coarse) {
        .show-sidebar-btn {
            position: relative;
            -webkit-tap-highlight-color: transparent;
        }

        .show-sidebar-btn::after {
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
