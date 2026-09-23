<script lang="ts">
    import { onMount } from 'svelte';
    import { listen } from '@tauri-apps/api/event';
    import { formatLastSync } from '$lib/stores/sync';
    import { toasts } from '$lib/services/toast';
    import { BackupProviderCard, ImportBackupDialog } from '$lib/settings';
    import {
        BACKUP_STATUS_EVENT,
        backUpToFile,
        closeBackup,
        getBackupStatus,
        importBackup,
        listBackupHistory,
        listProviders,
        openBackupFile,
        planBackupImport,
        type BackupImportResult,
        type BackupPreview,
        type BackupProvider,
        type BackupRecord,
        type BackupStatus,
        type ImportPlan,
    } from '$lib/backup';

    let status = $state<BackupStatus | null>(null);
    let history = $state<BackupRecord[]>([]);
    // Remote destinations this build can use. Empty in a build without
    // credentials for any, which shows nothing about them (ADR 0025).
    let providers = $state<BackupProvider[]>([]);

    let backingUp = $state(false);
    let opening = $state(false);
    let preview = $state<BackupPreview | null>(null);
    let plan = $state<ImportPlan | null>(null);
    let progress = $state<{ done: number; total: number } | null>(null);

    // One thing at a time: a backup and an import both read the whole library.
    let busy = $derived(backingUp || opening || preview !== null || status?.running === true);

    // A failure since the last good backup is shown beside it: the last good
    // backup is still the one the user can rely on, and the failure is why
    // there is not a newer one.
    let lastFailure = $derived(
        status?.latestAttempt?.status === 'failed' ? status.latestAttempt : null,
    );

    async function refresh() {
        try {
            [status, history] = await Promise.all([getBackupStatus(), listBackupHistory(10)]);
        } catch (error) {
            console.error('Failed to load the backup history:', error);
        }
    }

    async function refreshProviders() {
        try {
            providers = await listProviders();
        } catch (error) {
            console.error('Failed to load the backup providers:', error);
        }
    }

    function handleProvidersChanged() {
        void refreshProviders();
        void refresh();
    }

    onMount(() => {
        void refresh();
        void refreshProviders();

        // Registered asynchronously, so a page left before it resolves has to
        // unregister it itself.
        let left = false;
        let unlisten: (() => void) | null = null;
        listen(BACKUP_STATUS_EVENT, () => void refresh())
            .then((fn) => {
                if (left) fn();
                else unlisten = fn;
            })
            .catch((e) => console.warn('[backup] status events unavailable:', e));

        return () => {
            left = true;
            unlisten?.();
            // Leaving with a backup open but not imported: close it, so its
            // staged copy does not wait for the next start to be removed.
            if (preview && !progress) void closeBackup(preview);
        };
    });

    async function handleBackUp() {
        if (busy) return;
        backingUp = true;
        try {
            const result = await backUpToFile();
            // Null means the user closed the dialog; nothing to report.
            if (!result) return;

            toasts.success(
                `Backed up ${plural(result.documentCount, 'note')} and ` +
                    `${plural(result.attachmentCount, 'image')} to ${result.fileName}`,
            );
            // Both are partial backups, and the user is the only one who can
            // tell whether that matters.
            if (result.skippedAttachments > 0) {
                toasts.warning(
                    `${plural(result.skippedAttachments, 'image')} could not be included: ` +
                        'the files are missing or have not reached this device yet.',
                );
            }
            if (result.skippedDocuments.length > 0) {
                toasts.warning(
                    `Could not include the contents of ${result.skippedDocuments.join(', ')}.`,
                );
            }
        } catch (error) {
            console.error('Failed to back up:', error);
            toasts.error(`Backup failed: ${message(error)}`);
        } finally {
            backingUp = false;
            void refresh();
        }
    }

    async function handleOpen() {
        if (busy) return;
        opening = true;
        let opened: BackupPreview | null = null;
        try {
            opened = await openBackupFile();
            if (!opened) return;
            plan = await planBackupImport(opened);
            preview = opened;
        } catch (error) {
            console.error('Failed to open the backup:', error);
            toasts.error(`Could not open the backup: ${message(error)}`);
            if (opened) void closeBackup(opened);
        } finally {
            opening = false;
        }
    }

    // A backup downloaded from a provider, already checked: from here it is
    // the same as a file picked from disk.
    async function handleOpened(opened: BackupPreview) {
        try {
            plan = await planBackupImport(opened);
            preview = opened;
        } catch (error) {
            console.error('Failed to open the backup:', error);
            toasts.error(`Could not open the backup: ${message(error)}`);
            void closeBackup(opened);
        }
    }

    async function handleImport() {
        if (!preview || !plan || progress) return;
        const opened = preview;
        progress = { done: 0, total: 0 };
        try {
            const result = await importBackup(opened, plan, (done, total) => {
                progress = { done, total };
            });
            toasts.success(summarize(result));
            if (result.failedTitles.length > 0) {
                toasts.warning(`Could not import ${result.failedTitles.join(', ')}.`);
            }
            if (result.imagesFailed > 0) {
                toasts.warning(`${plural(result.imagesFailed, 'image')} could not be imported.`);
            }
        } catch (error) {
            console.error('Failed to import the backup:', error);
            toasts.error(`Import failed: ${message(error)}`);
        } finally {
            progress = null;
            preview = null;
            plan = null;
        }
    }

    function handleCancel() {
        if (preview) void closeBackup(preview);
        preview = null;
        plan = null;
    }

    function summarize(result: BackupImportResult): string {
        const parts: string[] = [];
        if (result.added > 0) parts.push(plural(result.added, 'new note'));
        if (result.restored > 0) parts.push(`${plural(result.restored, 'note')} brought back`);
        if (result.changed > 0) parts.push(`${plural(result.changed, 'note')} updated`);
        if (result.imagesImported > 0) parts.push(plural(result.imagesImported, 'new image'));
        if (parts.length === 0) return 'Nothing new: everything in the backup was already here.';
        return `Imported the backup: ${parts.join(', ')}.`;
    }

    function describe(record: BackupRecord): string {
        const parts = [
            plural(record.documentCount ?? 0, 'note'),
            plural(record.attachmentCount ?? 0, 'image'),
        ];
        if (record.sizeBytes !== null) parts.push(formatSize(record.sizeBytes));
        return parts.join(', ');
    }

    function outcome(record: BackupRecord): string {
        switch (record.status) {
            case 'success':
                return describe(record);
            case 'failed':
                return `Failed: ${record.error ?? 'unknown error'}`;
            case 'running':
                return 'In progress';
            case 'skipped':
                return 'Nothing had changed';
        }
    }

    // "3h ago" as a sentence continues, rather than as a label starts.
    function ago(at: number): string {
        const text = formatLastSync(at);
        return text.charAt(0).toLowerCase() + text.slice(1);
    }

    function fullDate(at: number): string {
        return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    function formatSize(bytes: number): string {
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    function plural(count: number, noun: string): string {
        return `${count} ${noun}${count === 1 ? '' : 's'}`;
    }

    // A Tauri command rejects with a string, not an Error.
    function message(error: unknown): string {
        if (typeof error === 'string') return error;
        return error instanceof Error ? error.message : 'unknown error';
    }
</script>

<div class="settings-page">
    <section class="settings-section">
        <h2 class="section-title">Last backup</h2>
        <div class="section-card">
            <div class="status">
                {#if status === null}
                    <span class="status-when">…</span>
                {:else if status.lastSuccess}
                    {@const last = status.lastSuccess}
                    <span class="status-when" title={fullDate(last.finishedAt ?? last.startedAt)}>
                        {formatLastSync(last.finishedAt ?? last.startedAt)}
                    </span>
                    <span class="status-detail">
                        {describe(last)} • {last.destinationLabel}
                    </span>
                {:else}
                    <span class="status-when">No backup yet</span>
                    <span class="status-detail">
                        Everything is only on your devices. A backup keeps a copy somewhere else.
                    </span>
                {/if}
                {#if status?.running}
                    <span class="status-running">Backing up now…</span>
                {:else if lastFailure}
                    <span class="status-failed">
                        The last attempt, {ago(lastFailure.startedAt)}, failed: {lastFailure.error ??
                            'unknown error'}
                    </span>
                {/if}
            </div>
        </div>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Back up</h2>
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Back up to a file</span>
                    <span class="setting-desc">
                        Every note, journal and image in one file, saved wherever you choose
                    </span>
                </div>
                <button class="action-btn" onclick={handleBackUp} disabled={busy}>
                    {backingUp ? 'Backing up…' : 'Back up now'}
                </button>
            </div>
        </div>
    </section>

    <section class="settings-section">
        <h2 class="section-title">Restore</h2>
        <div class="section-card">
            <div class="setting-row">
                <div class="setting-info">
                    <span class="setting-label">Import a backup</span>
                    <span class="setting-desc">
                        Merges a backup file into this device. Nothing here is removed.
                    </span>
                </div>
                <button class="action-btn" onclick={handleOpen} disabled={busy}>
                    {opening ? 'Checking…' : 'Import…'}
                </button>
            </div>
        </div>
    </section>

    {#each providers as provider (provider.id)}
        <BackupProviderCard
            {provider}
            {busy}
            onChanged={handleProvidersChanged}
            onOpened={handleOpened}
        />
    {/each}

    {#if history.length > 0}
        <section class="settings-section">
            <h2 class="section-title">Recent backups</h2>
            <div class="section-card">
                {#each history as record (record.id)}
                    <div class="history-row">
                        <span
                            class="history-dot"
                            class:ok={record.status === 'success'}
                            class:failed={record.status === 'failed'}
                            aria-hidden="true"
                        ></span>
                        <div class="history-info">
                            <span class="history-label">{record.destinationLabel}</span>
                            <span class="history-desc">
                                {fullDate(record.startedAt)} • {outcome(record)}
                            </span>
                        </div>
                    </div>
                {/each}
            </div>
        </section>
    {/if}
</div>

{#if preview && plan}
    <ImportBackupDialog
        {preview}
        {plan}
        {progress}
        onImport={handleImport}
        onCancel={handleCancel}
    />
{/if}

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

    .status {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 16px;
    }

    .status-when {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
    }

    .status-detail {
        font-size: 13px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }

    .status-running {
        margin-top: 8px;
        font-size: 13px;
        color: var(--status-pending);
    }

    .status-failed {
        margin-top: 8px;
        font-size: 13px;
        color: var(--status-error);
        overflow-wrap: anywhere;
    }

    .setting-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
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

    .history-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 16px;
    }

    .history-row + .history-row {
        border-top: 1px solid var(--border-color);
    }

    .history-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        margin-top: 6px;
        border-radius: 50%;
        background: var(--status-idle);
    }

    .history-dot.ok {
        background: var(--status-ok);
    }

    .history-dot.failed {
        background: var(--status-error);
    }

    .history-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .history-label {
        font-size: 14px;
        color: var(--text-primary);
        overflow-wrap: anywhere;
    }

    .history-desc {
        font-size: 12px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }
</style>
