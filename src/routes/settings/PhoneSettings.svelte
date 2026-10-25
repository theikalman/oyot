<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { appStore, theme } from '$lib/stores/app';
    import { connectedPeers, pairedDevices } from '$lib/stores/sync';
    import { saveTheme } from '$lib/services/theme';
    import { toasts } from '$lib/services/toast';
    import { openHelp } from '$lib/services/navigation';
    import { COLOR_SCHEMES, colorScheme, type ColorSchemeId } from '$lib/theme/schemes';
    import {
        getBackgroundSync,
        setBackgroundSync,
        type BackgroundSync,
    } from '$lib/sync/background';
    import { APP_VERSION } from '$lib/version';
    import Icon, { type IconName } from '$lib/components/Icon.svelte';

    // Settings on a phone: one list of grouped cards, each row a tap to what
    // it names, with what is most often changed (the colours, background
    // sync) right there rather than a page away.
    interface Props {
        /** How the backup stands, and whether that wants attention. */
        backupLabel: string;
        backupWarn: boolean;
        exporting: boolean;
        importLabel: string;
        importing: boolean;
        onExport: () => void;
        onImport: () => void;
    }

    let { backupLabel, backupWarn, exporting, importLabel, importing, onExport, onImport }: Props =
        $props();

    let schemeName = $derived(colorScheme($theme).name);

    async function choose(id: ColorSchemeId) {
        if (id === $theme) return;
        appStore.setTheme(id);
        try {
            await saveTheme(id);
        } catch {
            toasts.error('Could not save the color scheme. It will go back on the next start.');
        }
    }

    let syncCount = $derived(
        $pairedDevices.length > 0
            ? `${$connectedPeers.length} of ${$pairedDevices.length}`
            : 'Not paired',
    );

    // Null until read, and the row stays away on a platform without it.
    let background = $state<BackgroundSync | null>(null);
    let savingBackground = $state(false);

    onMount(() => {
        getBackgroundSync()
            .then((settings) => (background = settings))
            .catch(() => (background = null));
    });

    async function toggleBackground() {
        if (!background || savingBackground) return;
        const on = !background.enabled;
        savingBackground = true;
        try {
            await setBackgroundSync(on);
            background = await getBackgroundSync();
        } catch (error) {
            console.error('Failed to change background sync:', error);
            toasts.error(`Could not change that: ${error}`);
        } finally {
            savingBackground = false;
        }
    }
</script>

{#snippet tile(icon: IconName, tone: 'accent' | 'warn' | 'plain' = 'plain')}
    <span class="tile {tone}"><Icon name={icon} size={17} /></span>
{/snippet}

<h2 class="m-section">Appearance</h2>
<div class="card">
    <div class="row">
        {@render tile('sliders', 'accent')}
        <span class="label">Colour scheme</span>
        <span class="value">{schemeName}</span>
    </div>
    <div class="swatches" role="radiogroup" aria-label="Colour scheme">
        {#each COLOR_SCHEMES as scheme (scheme.id)}
            <button
                class="swatch"
                class:on={$theme === scheme.id}
                data-scheme={scheme.id}
                role="radio"
                aria-checked={$theme === scheme.id}
                aria-label="{scheme.family} {scheme.name}"
                onclick={() => choose(scheme.id)}
            >
                <i></i>
            </button>
        {/each}
    </div>
</div>

<h2 class="m-section">Sync</h2>
<div class="card">
    <button class="row" onclick={() => goto(resolve('/settings/sync'))}>
        {@render tile('sync', 'accent')}
        <span class="label">Devices &amp; sync</span>
        <span class="value">
            {#if $connectedPeers.length > 0}<span class="ok-dot"></span>{/if}{syncCount}
        </span>
        <Icon name="chevron-right" size={18} />
    </button>
    {#if background?.supported}
        <div class="row tall">
            {@render tile('today')}
            <span class="label">
                Sync in the background
                <small>
                    Picks up changes from your other devices now and then, even when Oyot is closed
                </small>
            </span>
            <button
                class="switch"
                class:on={background.enabled}
                role="switch"
                aria-checked={background.enabled}
                aria-label="Sync in the background"
                disabled={savingBackground}
                onclick={toggleBackground}
            ></button>
        </div>
    {/if}
</div>

<h2 class="m-section">Your notes</h2>
<div class="card">
    <button class="row" onclick={() => goto(resolve('/settings/backup'))}>
        {@render tile('backup', backupWarn ? 'warn' : 'plain')}
        <span class="label">Backup</span>
        {#if backupWarn}
            <span class="badge warn">{backupLabel}</span>
        {:else}
            <span class="value">{backupLabel}</span>
        {/if}
        <Icon name="chevron-right" size={18} />
    </button>
    <button class="row" onclick={onExport} disabled={exporting}>
        {@render tile('download')}
        <span class="label">{exporting ? 'Exporting...' : 'Export as Markdown'}</span>
    </button>
    <button class="row" onclick={onImport} disabled={importing}>
        {@render tile('notes')}
        <span class="label">{importing ? importLabel : 'Import Markdown'}</span>
    </button>
</div>

<h2 class="m-section">Oyot</h2>
<div class="card">
    <button class="row" onclick={() => openHelp()}>
        {@render tile('help')}
        <span class="label">Help and gestures</span>
        <Icon name="chevron-right" size={18} />
    </button>
    <button class="row" onclick={() => goto(resolve('/settings/about'))}>
        {@render tile('info')}
        <span class="label">About Oyot</span>
        <span class="value mono">{APP_VERSION}</span>
        <Icon name="chevron-right" size={18} />
    </button>
</div>

<style>
    .m-section {
        margin: 0;
        padding-left: 4px;
    }

    .card {
        border-radius: 16px;
        background: var(--bg-raised);
        box-shadow: 0 0 0 1px var(--border-color);
        overflow: hidden;
    }

    .row {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 54px;
        padding: 0 14px;
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: 16px;
        text-align: left;
        -webkit-tap-highlight-color: transparent;
    }

    .row + .row {
        box-shadow: 0 -1px 0 var(--border-color);
    }

    .row.tall {
        align-items: flex-start;
        padding-top: 12px;
        padding-bottom: 12px;
    }

    .row > :global(.icon:last-child) {
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .label {
        flex: 1;
        min-width: 0;
    }

    .label small {
        display: block;
        margin-top: 2px;
        font-size: 13.5px;
        line-height: 1.4;
        color: var(--text-muted);
    }

    .value {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        font-size: 15px;
        color: var(--text-muted);
        white-space: nowrap;
    }

    .value.mono {
        font-family: var(--font-mono);
        font-size: 13px;
    }

    .ok-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--status-ok);
    }

    .tile {
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: var(--bg-secondary);
        color: var(--text-secondary);
    }

    .tile.accent {
        background: var(--accent-bg);
        color: var(--accent-color);
    }

    .tile.warn {
        background: var(--warn-bg);
        color: var(--warn-text);
    }

    .swatches {
        display: flex;
        gap: 8px;
        padding: 0 14px 14px 56px;
    }

    /* Each in its own scheme's colours: its page, with its accent in the
       corner. */
    .swatch {
        position: relative;
        width: 30px;
        height: 30px;
        padding: 0;
        border: none;
        border-radius: 50%;
        overflow: hidden;
        background: var(--bg-primary);
        box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.1);
    }

    .swatch i {
        position: absolute;
        right: 0;
        bottom: 0;
        width: 50%;
        height: 50%;
        background: var(--accent-color);
    }

    .swatch.on {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }

    .switch {
        position: relative;
        flex-shrink: 0;
        width: 46px;
        height: 28px;
        margin-top: 2px;
        padding: 0;
        border: none;
        border-radius: 999px;
        background: var(--control-line);
        transition: background-color 0.15s;
    }

    .switch::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
        transition: transform 0.15s;
    }

    .switch.on {
        background: var(--status-ok);
    }

    .switch.on::after {
        transform: translateX(18px);
    }
</style>
