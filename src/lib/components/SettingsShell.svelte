<script lang="ts" module>
    // Where the user was before Settings, so Back and Esc return there rather
    // than always to today's journal. Set by the root layout on every
    // navigation outside Settings.
    let returnPath = '/';

    export function rememberWorkspacePath(path: string): void {
        if (!path.startsWith('/settings')) returnPath = path;
    }
</script>

<script lang="ts">
    import type { Snippet } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { APP_VERSION } from '$lib/version';
    import { pairedDevices, connectedPeers } from '$lib/stores/sync';
    import Icon, { type IconName } from './Icon.svelte';
    import SidebarSyncRow from './SidebarSyncRow.svelte';
    import { isSmallScreen } from './Sidebar.svelte';

    // Settings in the same shell as the rest of the app: the sidebar swaps to
    // the settings sections, and the sheet holds the page. It used to be a
    // separate full screen with a close button, which lost the sidebar and
    // with it any sense of where in the app Settings is.
    interface Props {
        title: string;
        /** A line under the title saying what the page is for. */
        description?: string;
        children: Snippet;
    }

    let { title, description, children }: Props = $props();

    const SECTIONS: { path: string; label: string; icon: IconName }[] = [
        { path: '/settings', label: 'General', icon: 'sliders' },
        { path: '/settings/shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard' },
        { path: '/settings/sync', label: 'Devices & sync', icon: 'sync' },
        { path: '/settings/backup', label: 'Backup', icon: 'backup' },
        { path: '/settings/about', label: 'About Oyot', icon: 'info' },
    ];

    let here = $derived(page.url.pathname);
    let small = $state(isSmallScreen());
    $effect(() => {
        const mq = window.matchMedia('(max-width: 768px)');
        const onChange = (e: MediaQueryListEvent) => (small = e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    let syncCount = $derived(
        $pairedDevices.length > 0 ? `${$connectedPeers.length} of ${$pairedDevices.length}` : '',
    );

    function leave() {
        void goto(returnPath);
    }

    // On a phone a section is a page of its own, and back goes up to the
    // list of sections; from the list, back leaves Settings.
    function back() {
        if (small && here !== '/settings') void goto('/settings');
        else leave();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        if (document.querySelector('[aria-modal="true"]')) return;
        // A field being typed in answers Esc itself, by cancelling.
        if (event.target instanceof Element && event.target.closest('input, textarea')) return;
        event.preventDefault();
        leave();
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="settings-shell">
    {#if !small}
        <aside class="settings-nav" aria-label="Settings sections">
            <div class="nav-top">
                <button class="back-btn" onclick={leave}>
                    <Icon name="arrow-left" size={16} />Back to Oyot
                </button>
                <span class="kbd">Esc</span>
            </div>
            <div class="nav-title">
                <h1>Settings</h1>
            </div>
            <nav class="nav">
                {#each SECTIONS as section (section.path)}
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- fixed paths -->
                    <a
                        class="nav-item"
                        class:active={here === section.path}
                        aria-current={here === section.path ? 'page' : undefined}
                        href={section.path}
                    >
                        <Icon name={section.icon} />
                        <span class="nav-label">{section.label}</span>
                        {#if section.path === '/settings/sync' && syncCount}
                            <span class="nav-count">{syncCount}</span>
                        {:else if section.path === '/settings/about'}
                            <span class="nav-count">{APP_VERSION.replace(/-.*$/, '')}</span>
                        {/if}
                    </a>
                {/each}
            </nav>
            <div class="nav-foot">
                <SidebarSyncRow />
            </div>
        </aside>
    {/if}

    <div class="sheet">
        <header class="sheet-head">
            {#if small}
                <button class="icon-btn" onclick={back} aria-label="Back">
                    <Icon name="chevron-left" size={22} />
                </button>
            {:else}
                <span class="crumb">Settings</span>
                <span class="crumb-sep">/</span>
            {/if}
            <span class="crumb current">{title}</span>
        </header>
        <div class="sheet-body">
            <div class="content">
                <h2 class="page-title">{title}</h2>
                {#if description}
                    <p class="page-desc">{description}</p>
                {/if}
                {@render children()}
            </div>
        </div>
    </div>
</main>

<style>
    .settings-shell {
        height: calc(100dvh - var(--safe-top) - var(--safe-bottom));
        display: flex;
        background: var(--bg-secondary);
    }

    .settings-nav {
        width: 264px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        padding: 10px 10px 10px 12px;
    }

    .nav-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 40px;
    }

    .back-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 32px;
        padding: 0 10px 0 8px;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 550;
        cursor: pointer;
    }

    .back-btn:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .nav-title h1 {
        margin: 0;
        padding: 12px 10px 10px;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: -0.02em;
    }

    .nav {
        display: flex;
        flex-direction: column;
        gap: 1px;
    }

    .nav-item {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 34px;
        padding: 0 10px;
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 500;
        text-decoration: none;
    }

    .nav-item:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }

    .nav-item.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sheet);
    }

    .nav-item.active :global(.icon) {
        color: var(--accent-color);
    }

    .nav-label {
        flex: 1;
    }

    .nav-count {
        font-size: 12px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
    }

    .nav-foot {
        margin-top: auto;
        padding-top: 8px;
        border-top: 1px solid var(--border-color);
    }

    .sheet {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        margin: 8px 8px 8px 0;
        background: var(--bg-primary);
        border-radius: var(--radius-sheet);
        box-shadow: var(--shadow-sheet);
        overflow: hidden;
    }

    .sheet-head {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        height: 52px;
        padding: 0 20px;
        border-bottom: 1px solid var(--border-color);
        font-size: 13.5px;
    }

    .crumb {
        color: var(--text-muted);
    }

    .crumb-sep {
        color: var(--border-light);
    }

    .crumb.current {
        color: var(--text-primary);
        font-weight: 550;
    }

    .icon-btn {
        width: 40px;
        height: 40px;
        margin-left: -12px;
        display: grid;
        place-items: center;
        border: none;
        border-radius: var(--radius-md);
        background: none;
        color: var(--text-primary);
        cursor: pointer;
    }

    .sheet-body {
        flex: 1;
        overflow-y: auto;
        padding: 30px 48px 64px;
    }

    .content {
        max-width: 780px;
    }

    .page-title {
        margin: 0;
        font-size: 26px;
        line-height: 32px;
        font-weight: 650;
        letter-spacing: -0.024em;
    }

    .page-desc {
        margin: 4px 0 0;
        font-size: 13px;
        color: var(--text-muted);
    }

    .content > :global(*:nth-child(2)),
    .content > .page-desc + :global(*) {
        margin-top: 24px;
    }

    @media (max-width: 768px) {
        .sheet {
            margin: 0;
            border-radius: 0;
            box-shadow: none;
        }

        .sheet-body {
            padding: 20px 16px 48px;
        }
    }
</style>
