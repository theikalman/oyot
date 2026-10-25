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
    import { resolve } from '$app/paths';
    import { page } from '$app/state';
    import { APP_VERSION } from '$lib/version';
    import { pairedDevices, connectedPeers } from '$lib/stores/sync';
    import Icon, { type IconName } from './Icon.svelte';
    import SidebarSyncRow from './SidebarSyncRow.svelte';
    import { isSmallScreen } from './Sidebar.svelte';
    import { pullToRefresh, PULL_THRESHOLD } from '$lib/gestures/pullToRefresh';

    // Settings in the same shell as the rest of the app: the sidebar swaps to
    // the settings sections, and the sheet holds the page. It used to be a
    // separate full screen with a close button, which lost the sidebar and
    // with it any sense of where in the app Settings is.
    interface Props {
        title: string;
        /** A line under the title saying what the page is for. */
        description?: string;
        /** On a phone, the large title and the line under it, when not the above. */
        phoneTitle?: string;
        phoneDescription?: string;
        /**
         * On a phone, what pulling the page down from its top does, and what
         * to say while it runs. Without it, a pull is only a scroll.
         */
        onPull?: () => Promise<void>;
        pullLabel?: string;
        children: Snippet;
    }

    let {
        title,
        description,
        phoneTitle,
        phoneDescription,
        onPull,
        pullLabel = 'Checking',
        children,
    }: Props = $props();

    let pulled = $state(0);
    let refreshing = $state(false);

    async function refresh() {
        if (!onPull || refreshing) return;
        refreshing = true;
        try {
            await onPull();
        } finally {
            // Long enough to read as having happened.
            setTimeout(() => (refreshing = false), 900);
        }
    }

    // On only on a phone, and only on a page with something to pull for.
    function maybePull(node: HTMLElement, on: boolean) {
        const options = { onPull: (d: number) => (pulled = d), onRefresh: refresh };
        let action = on ? pullToRefresh(node, options) : null;
        return {
            update(next: boolean) {
                if (next && !action) action = pullToRefresh(node, options);
                if (!next && action) {
                    action.destroy();
                    action = null;
                }
            },
            destroy: () => action?.destroy(),
        };
    }

    const SECTIONS = [
        { path: '/settings', label: 'General', icon: 'sliders' },
        { path: '/settings/shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard' },
        { path: '/settings/sync', label: 'Devices & sync', icon: 'sync' },
        { path: '/settings/backup', label: 'Backup', icon: 'backup' },
        { path: '/settings/about', label: 'About Oyot', icon: 'info' },
    ] as const satisfies readonly { path: string; label: string; icon: IconName }[];

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
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- a path the app was on, already resolved
        void goto(returnPath);
    }

    // On a phone a section is a page of its own, and back goes up to the
    // list of sections; from the list, back leaves Settings.
    function back() {
        if (small && here !== '/settings') void goto(resolve('/settings'));
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
                    <a
                        class="nav-item"
                        class:active={here === section.path}
                        aria-current={here === section.path ? 'page' : undefined}
                        href={resolve(section.path)}
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
        {#if small}
            <!-- A phone's way: back on a bar of its own, then the page's
                 name large, over grouped cards on the frame. -->
            <header class="phone-head">
                <button class="m-btn" onclick={back} aria-label="Back">
                    <Icon name="chevron-left" size={24} />
                </button>
            </header>
        {:else}
            <header class="sheet-head">
                <span class="crumb">Settings</span>
                <span class="crumb-sep">/</span>
                <span class="crumb current">{title}</span>
            </header>
        {/if}
        <div class="sheet-body" use:maybePull={small && !!onPull}>
            {#if small && onPull && (pulled > 0 || refreshing)}
                <div
                    class="pull"
                    class:ready={pulled >= PULL_THRESHOLD}
                    style:height="{refreshing ? 56 : pulled}px"
                    role="status"
                >
                    <span
                        class="spinner"
                        class:spinning={refreshing}
                        style:transform="rotate({pulled * 4}deg)"
                    ></span>
                    {#if refreshing}
                        {pullLabel}
                    {:else if pulled >= PULL_THRESHOLD}
                        Let go to check
                    {:else}
                        Pull to check
                    {/if}
                </div>
            {/if}
            <div class="content">
                {#if small}
                    <div class="phone-title">
                        <h1 class="m-title">{phoneTitle ?? title}</h1>
                        {#if phoneDescription ?? description}
                            <p class="m-sub">{phoneDescription ?? description}</p>
                        {/if}
                    </div>
                {:else}
                    <h2 class="page-title">{title}</h2>
                    {#if description}
                        <p class="page-desc">{description}</p>
                    {/if}
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

    .phone-head {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        height: 52px;
        padding: 0 8px;
    }

    .pull {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        overflow: hidden;
        font-size: 13.5px;
        font-weight: 550;
        color: var(--text-muted);
    }

    .pull.ready {
        color: var(--accent-color);
    }

    .spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid var(--control-line);
        border-top-color: var(--accent-color);
    }

    .spinner.spinning {
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .phone-title {
        padding: 0 4px 6px;
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
            background: var(--bg-secondary);
        }

        .sheet-body {
            padding: 0 16px 48px;
        }

        .content > :global(*:nth-child(2)) {
            margin-top: 8px;
        }
    }
</style>
