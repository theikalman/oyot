<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { appStore, theme } from '$lib/stores/app';
    import { canSignal, connectedPeers } from '$lib/stores/sync';
    import type { Theme } from '$lib/types';
    import { invoke } from '@tauri-apps/api/core';
    import { exportAllNotes } from '$lib/export';
    import { markdownImport } from '$lib/import';
    import {
        getBackupSchedule,
        getBackupStatus,
        type BackupStatus,
        type ScheduleView,
    } from '$lib/backup';
    import { formatLastSync } from '$lib/stores/sync';
    import {
        getDesktopSettings,
        setKeepRunning,
        setStartAtLogin,
        trayPlace,
        type DesktopSettings,
    } from '$lib/desktop';
    import { toasts } from '$lib/services/toast';
    import { openDocument, openHelp, openNotes } from '$lib/services/navigation';
    import { customShortcuts } from '$lib/keyboard/customShortcuts.svelte';
    import { onDestroy, onMount } from 'svelte';

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

    function goToShortcutSettings() {
        goto(resolve('/settings/shortcuts'));
    }

    let shortcutSummary = $derived(
        customShortcuts.changedCount > 0
            ? `${customShortcuts.changedCount} changed • Choose the keys for formatting, undo and more`
            : 'Choose your own keys for formatting, undo and more',
    );

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

    // Closing to the tray and starting at login (ADR 0030). Null until read,
    // and the section stays hidden on a phone, where neither applies.
    let desktop = $state<DesktopSettings | null>(null);
    let place = $state('the system tray');
    let savingDesktop = $state(false);

    async function handleKeepRunning(event: Event) {
        // Read before the await: an event's target is gone once it has run.
        const input = event.currentTarget as HTMLInputElement;
        const keepRunning = input.checked;
        savingDesktop = true;
        try {
            await setKeepRunning(keepRunning);
            if (desktop) desktop = { ...desktop, keepRunning };
        } catch (error) {
            console.error('Failed to change keeping Oyot running:', error);
            toasts.error(`Could not change that: ${message(error)}`);
            input.checked = !keepRunning;
        } finally {
            savingDesktop = false;
        }
    }

    async function handleStartAtLogin(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const wanted = input.checked;
        savingDesktop = true;
        try {
            // What the OS now has, which may not be what was asked for.
            const startAtLogin = await setStartAtLogin(wanted);
            input.checked = startAtLogin;
            if (desktop) desktop = { ...desktop, startAtLogin };
        } catch (error) {
            console.error('Failed to change starting at login:', error);
            toasts.error(`Could not change that: ${message(error)}`);
            input.checked = !wanted;
        } finally {
            savingDesktop = false;
        }
    }

    onMount(() => {
        getDesktopSettings()
            .then((settings) => (desktop = settings))
            .catch((error) => console.error('Failed to load the desktop settings:', error));
        void trayPlace().then((name) => (place = name));
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

    // The way back in for what Export writes out, and for Markdown from
    // anywhere else. Where the notes went is not on this page, so the import
    // ends there: on the one note, or on the Notes page with the rest, unless
    // the user has gone elsewhere since. Whether an import is running, and how
    // far it has got, is shared with the Notes page, which can start one too.
    let here = true;
    onDestroy(() => (here = false));

    async function handleImport() {
        const result = await markdownImport.start();
        if (!here || !result || result.notes.length === 0) return;
        if (result.notes.length === 1) await openDocument(result.notes[0].id);
        else await openNotes();
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
        <h2 class="section-title">Keyboard</h2>
        <button class="section-card settings-link" onclick={goToShortcutSettings}>
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Keyboard shortcuts</span>
                    <span class="setting-desc">{shortcutSummary}</span>
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

    {#if desktop?.supported}
        <section class="settings-section">
            <h2 class="section-title">Desktop</h2>
            <div class="section-card">
                <label class="setting-row">
                    <span class="setting-info">
                        <span class="setting-label"
                            >Keep Oyot running when the window is closed</span
                        >
                        <span class="setting-desc">
                            Your notes keep syncing. Quit Oyot from its icon in {place}.
                        </span>
                    </span>
                    <input
                        type="checkbox"
                        checked={desktop.keepRunning}
                        onchange={handleKeepRunning}
                        disabled={savingDesktop}
                    />
                </label>
                <label class="setting-row">
                    <span class="setting-info">
                        <span class="setting-label">Start Oyot when you log in</span>
                        <span class="setting-desc">
                            It starts in {place}, without opening a window.
                        </span>
                    </span>
                    <input
                        type="checkbox"
                        checked={desktop.startAtLogin}
                        onchange={handleStartAtLogin}
                        disabled={savingDesktop}
                    />
                </label>
            </div>
        </section>
    {/if}

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
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Import notes</span>
                    <span class="setting-desc">
                        Make a note of each Markdown file you pick, exported from Oyot or written
                        anywhere else
                    </span>
                </div>
                <button class="action-btn" onclick={handleImport} disabled={markdownImport.running}>
                    {markdownImport.label}
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
        gap: 12px;
        padding: 16px;
    }

    .setting-row + .setting-row {
        border-top: 1px solid var(--border-color);
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

    label.setting-row {
        cursor: pointer;
    }

    .setting-row input[type='checkbox'] {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        cursor: pointer;
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
