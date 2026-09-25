<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { appStore, theme } from '$lib/stores/app';
    import { canSignal, connectedPeers } from '$lib/stores/sync';
    import type { Theme } from '$lib/types';
    import { invoke } from '@tauri-apps/api/core';
    import { exportAllNotes } from '$lib/export';
    import {
        getBackupSchedule,
        getBackupStatus,
        type BackupStatus,
        type ScheduleView,
    } from '$lib/backup';
    import { formatLastSync } from '$lib/stores/sync';
    import { toasts } from '$lib/services/toast';
    import { openHelp } from '$lib/services/navigation';
    import { onMount } from 'svelte';

    let currentTheme = $derived($theme);
    let syncSummary = $derived(
        $connectedPeers.length > 0
            ? `${$connectedPeers.length} device${$connectedPeers.length !== 1 ? 's' : ''} connected`
            : // Ready when this device can reach something: it is searching
              // this network, or an address it holds is answering (ADR 0023).
              $canSignal
              ? 'Ready to pair'
              : 'Offline',
    );

    async function handleThemeToggle() {
        const next: Theme = currentTheme === 'light' ? 'dark' : 'light';
        appStore.setTheme(next);
        try {
            await invoke('save_theme', { theme: next });
        } catch (error) {
            console.error('Failed to save theme:', error);
        }
    }

    function goToSyncSettings() {
        goto(resolve('/settings/sync'));
    }

    function goToBackupSettings() {
        goto(resolve('/settings/backup'));
    }

    function goToHelp() {
        void openHelp();
    }

    let backupStatus = $state<BackupStatus | null>(null);
    let backupSchedule = $state<ScheduleView | null>(null);
    let backupSummary = $derived.by(() => {
        if (!backupStatus) return 'Back up to a file, or import a backup';
        const last = backupStatus.lastSuccess;
        // Trouble is the thing worth seeing from here; the page it opens
        // says the rest.
        if (backupSchedule?.paused) return 'Scheduled backups are paused';
        if (backupStatus.latestAttempt?.status === 'failed') return 'The last backup failed';
        if (!last) return 'No backup yet';
        return `Last backup ${formatLastSync(last.finishedAt ?? last.startedAt).toLowerCase()}`;
    });

    onMount(() => {
        getBackupStatus()
            .then((status) => (backupStatus = status))
            .catch((error) => console.error('Failed to load the backup status:', error));
        getBackupSchedule()
            .then((schedule) => (backupSchedule = schedule))
            .catch((error) => console.error('Failed to load the backup schedule:', error));
    });

    let exporting = $state(false);

    // The whole corpus is rendered before the save dialog opens, which on a
    // large library is a visible wait, so the button says what it is doing and
    // cannot be pressed twice.
    async function handleExport() {
        if (exporting) return;
        exporting = true;
        try {
            const summary = await exportAllNotes();
            // Null means the user closed the save dialog; nothing to report.
            if (!summary) return;

            const parts = [`Exported ${plural(summary.noteCount, 'note')}`];
            if (summary.attachmentCount > 0) {
                parts.push(`and ${plural(summary.attachmentCount, 'image')}`);
            }
            toasts.success(`${parts.join(' ')} to ${filename(summary.path)}`);

            // Both of these are partial exports, and the user is the only one
            // who can tell whether that matters.
            if (summary.missingAttachmentCount > 0) {
                toasts.warning(
                    `${plural(summary.missingAttachmentCount, 'image')} could not be included: ` +
                        'their files have not reached this device yet.',
                );
            }
            if (summary.failedTitles.length > 0) {
                toasts.warning(
                    `Could not read the contents of ${summary.failedTitles.join(', ')}.`,
                );
            }
        } catch (error) {
            console.error('Failed to export notes:', error);
            toasts.error(`Export failed: ${message(error)}`);
        } finally {
            exporting = false;
        }
    }

    function plural(count: number, noun: string): string {
        return `${count} ${noun}${count === 1 ? '' : 's'}`;
    }

    function filename(path: string): string {
        return path.split(/[\\/]/).pop() || path;
    }

    // A Tauri command rejects with a string, not an Error.
    function message(error: unknown): string {
        if (typeof error === 'string') return error;
        return error instanceof Error ? error.message : 'unknown error';
    }
</script>

<div class="settings-page">
    <section class="settings-section">
        <h2 class="section-title">Appearance</h2>
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Theme</span>
                    <span class="setting-desc">Switch between light and dark mode</span>
                </div>
                <button
                    class="theme-toggle-btn"
                    onclick={handleThemeToggle}
                    title={currentTheme === 'light'
                        ? 'Switch to dark mode'
                        : 'Switch to light mode'}
                >
                    {currentTheme === 'light' ? '☾' : '☀'}
                </button>
            </div>
        </div>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Sync</h2>
        <button class="section-card settings-link" onclick={goToSyncSettings}>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Sync Settings</span>
                    <span class="setting-desc">
                        {syncSummary} • Manage paired devices and sync options
                    </span>
                </div>
                <svg
                    class="chevron"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M9 18l6-6-6-6" />
                </svg>
            </div>
        </button>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Backup</h2>
        <button class="section-card settings-link" onclick={goToBackupSettings}>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Backup & restore</span>
                    <span class="setting-desc">{backupSummary}</span>
                </div>
                <svg
                    class="chevron"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M9 18l6-6-6-6" />
                </svg>
            </div>
        </button>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Data</h2>
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Export notes</span>
                    <span class="setting-desc">
                        Save every note as a Markdown file, with its images, in a zip
                    </span>
                </div>
                <button class="action-btn" onclick={handleExport} disabled={exporting}>
                    {exporting ? 'Exporting…' : 'Export'}
                </button>
            </div>
        </div>
    </section>

    <!-- Also at the bottom of the sidebar. Here as well because settings is
         where people look for help, and on a phone the sidebar is hidden. -->
    <section class="settings-section">
        <h2 class="section-title">Help</h2>
        <button class="section-card settings-link" onclick={goToHelp}>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Help & shortcuts</span>
                    <span class="setting-desc">
                        What the colors mean, every keyboard shortcut, and tips
                    </span>
                </div>
                <svg
                    class="chevron"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M9 18l6-6-6-6" />
                </svg>
            </div>
        </button>
    </section>
</div>

<style>
    .settings-page {
        max-width: 600px;
        margin: 0 auto;
        padding: 24px;
    }

    .settings-section {
        margin-bottom: 32px;
    }

    .section-title {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .section-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        overflow: hidden;
    }

    .setting-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
    }

    .setting-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .setting-label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 15px;
    }

    .setting-desc {
        font-size: 13px;
        color: var(--text-muted);
    }

    .theme-toggle-btn {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        font-size: 20px;
        cursor: pointer;
        color: var(--text-primary);
        transition: background-color 0.15s;
    }

    .theme-toggle-btn:hover {
        background: var(--bg-hover);
    }

    .action-btn {
        padding: 10px 18px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        color: var(--text-primary);
        transition: background-color 0.15s;
        white-space: nowrap;
    }

    .action-btn:hover:not(:disabled) {
        background: var(--bg-hover);
    }

    .action-btn:disabled {
        cursor: default;
        color: var(--text-muted);
    }

    .settings-link {
        background: transparent;
        border: 1px solid var(--border-color);
        border-radius: 12px;
        cursor: pointer;
        width: 100%;
        text-align: left;
        padding: 0;
    }

    .settings-link:hover {
        background: var(--bg-hover);
    }

    .chevron {
        color: var(--text-muted);
        flex-shrink: 0;
    }
</style>
