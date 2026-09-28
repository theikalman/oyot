<script lang="ts">
    import { onMount } from 'svelte';
    import { toasts } from '$lib/services/toast';
    import {
        describeLastRun,
        getBackgroundSync,
        scheduleNote,
        setBackgroundSync,
        setBackgroundSyncMobileData,
        type BackgroundSync,
    } from '$lib/sync/background';

    // A phone's background sync (ADR 0034): two switches, when the system
    // runs it, and how the last run went. Hidden on a desktop, which keeps
    // running in the tray instead.
    let settings = $state<BackgroundSync | null>(null);
    let platform = $state('android');
    let saving = $state(false);

    let lastRun = $derived(settings ? describeLastRun(settings.lastRun) : '');

    async function refresh() {
        try {
            settings = await getBackgroundSync();
        } catch (error) {
            console.error('Failed to load the background sync settings:', error);
        }
    }

    onMount(() => {
        void refresh();
        void import('@tauri-apps/plugin-os')
            .then(({ platform: current }) => (platform = current()))
            .catch(() => {});
        // A run may have happened while the app was away, which is the
        // moment someone comes back to look.
        const onVisible = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    });

    async function change(event: Event, apply: (on: boolean) => Promise<void>) {
        // Read before the await: an event's target is gone once it has run.
        const input = event.currentTarget as HTMLInputElement;
        const on = input.checked;
        saving = true;
        try {
            await apply(on);
            await refresh();
        } catch (error) {
            console.error('Failed to change background sync:', error);
            toasts.error(`Could not change that: ${error}`);
            input.checked = !on;
        } finally {
            saving = false;
        }
    }
</script>

{#if settings?.supported}
    <section class="section">
        <h2>Background Sync</h2>
        <p class="intro">{scheduleNote(platform)}</p>

        <div class="card">
            <label class="row">
                <span class="info">
                    <span class="label">Sync in the background</span>
                </span>
                <input
                    type="checkbox"
                    checked={settings.enabled}
                    disabled={saving}
                    onchange={(event) => change(event, setBackgroundSync)}
                />
            </label>
            <label class="row">
                <span class="info">
                    <span class="label">Also on mobile data</span>
                    <span class="desc">Images still wait for Wi-Fi.</span>
                </span>
                <input
                    type="checkbox"
                    checked={settings.mobileData}
                    disabled={saving || !settings.enabled}
                    onchange={(event) => change(event, setBackgroundSyncMobileData)}
                />
            </label>
        </div>

        <p class="last-run">{lastRun}</p>
    </section>
{/if}

<style>
    .section {
        margin-bottom: 32px;
    }
    .section h2 {
        margin: 0 0 16px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
    }
    .intro {
        margin: 0 0 12px 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-muted);
    }
    .card {
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
    }
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 44px;
        padding: 10px 14px;
        cursor: pointer;
    }
    .row + .row {
        border-top: 1px solid var(--border-color);
    }
    .info {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .label {
        font-size: 14px;
        color: var(--text-primary);
    }
    .desc {
        font-size: 12px;
        color: var(--text-muted);
    }
    .row input[type='checkbox'] {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        cursor: pointer;
    }
    .row input[type='checkbox']:disabled {
        cursor: not-allowed;
    }
    .last-run {
        margin: 10px 0 0 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--text-secondary);
    }
</style>
