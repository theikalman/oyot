<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { listen } from '@tauri-apps/api/event';
    import Modal from '$lib/components/Modal.svelte';
    import { toasts } from '$lib/services/toast';
    import {
        BACKUP_PROGRESS_EVENT,
        backUpToProvider,
        cancelLink,
        deleteRemoteBackup,
        describeProgress,
        linkProvider,
        listProviders,
        listRemoteBackups,
        openRemoteBackup,
        unlinkProvider,
        type BackupPreview,
        type BackupProgress,
        type BackupProvider,
        type RemoteBackup,
    } from '$lib/backup';

    interface Props {
        provider: BackupProvider;
        /** Something else on the page is backing up or importing. */
        busy: boolean;
        /** The link or the history changed: read them again. */
        onChanged: () => void;
        /** A backup was downloaded and checked, ready for the import preview. */
        onOpened: (preview: BackupPreview) => void;
        /**
         * Goes up whenever the backup history changes. The list is read again
         * then: a scheduled backup may have landed here, or pruned older ones.
         */
        historyRevision: number;
    }

    let { provider, busy, onChanged, onOpened, historyRevision }: Props = $props();

    // Rust's word for a link the user called off, which is not worth a toast.
    const CANCELLED = 'linking was cancelled';

    let linking = $state(false);
    let backingUp = $state(false);
    let restoringId = $state<string | null>(null);
    let progress = $state<BackupProgress | null>(null);

    let backups = $state<RemoteBackup[]>([]);
    let listed = $state(false);
    let listError = $state<string | null>(null);

    let confirmUnlink = $state(false);
    let confirmDelete = $state<RemoteBackup | null>(null);

    let working = $derived(linking || backingUp || restoringId !== null);
    let account = $derived(provider.account);
    // What the list follows. A string, not the account object, so the page
    // reading the providers again does not reload a list that has not changed.
    let linkedEmail = $derived(provider.account?.email ?? null);

    // The list follows the link: read when an account is linked, cleared when
    // it is not. Read again when a backup lands here from elsewhere on the
    // page, or from the schedule.
    $effect(() => {
        void historyRevision;
        if (linkedEmail) {
            untrack(() => void loadBackups());
        } else {
            backups = [];
            listed = false;
            listError = null;
        }
    });

    onMount(() => {
        let left = false;
        let unlisten: (() => void) | null = null;
        listen<BackupProgress>(BACKUP_PROGRESS_EVENT, (event) => {
            // Only while this card started something: the page has one
            // transfer at a time, but not necessarily this card's.
            if (backingUp || restoringId !== null) progress = event.payload;
        })
            .then((fn) => {
                if (left) fn();
                else unlisten = fn;
            })
            .catch((e) => console.warn('[backup] progress events unavailable:', e));
        return () => {
            left = true;
            unlisten?.();
            // Leaving while the browser is still open for sign-in: stop
            // waiting for it.
            if (linking) void cancelLink();
        };
    });

    async function loadBackups() {
        try {
            backups = await listRemoteBackups(provider.id);
            listError = null;
        } catch (error) {
            listError = message(error);
            // A link that has ended is forgotten on the Rust side, and then the
            // page has to hear it so this card says "not linked". Any other
            // failure stays an error here: telling the page would redraw this
            // card, which would list again, and fail again.
            try {
                const current = await listProviders();
                if (!current.find((p) => p.id === provider.id)?.account) onChanged();
            } catch {
                // Nothing more to learn; the error above is already shown.
            }
        } finally {
            listed = true;
        }
    }

    async function handleLink() {
        linking = true;
        try {
            const linked = await linkProvider(provider.id);
            toasts.success(`Linked to ${linked.email}`);
            onChanged();
        } catch (error) {
            if (message(error) !== CANCELLED) toasts.error(`Could not link: ${message(error)}`);
        } finally {
            linking = false;
        }
    }

    async function handleBackUp() {
        backingUp = true;
        progress = { phase: 'building', done: 0, total: 0 };
        try {
            const result = await backUpToProvider(provider.id);
            toasts.success(
                `Backed up ${plural(result.documentCount, 'note')} and ` +
                    `${plural(result.attachmentCount, 'image')} to ${provider.name}`,
            );
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
            await loadBackups();
        } catch (error) {
            toasts.error(`Backup failed: ${message(error)}`);
            onChanged();
        } finally {
            backingUp = false;
            progress = null;
        }
    }

    async function handleRestore(backup: RemoteBackup) {
        restoringId = backup.id;
        progress = { phase: 'downloading', done: 0, total: backup.size ?? 0 };
        try {
            onOpened(await openRemoteBackup(provider.id, backup.id));
        } catch (error) {
            toasts.error(`Could not open the backup: ${message(error)}`);
        } finally {
            restoringId = null;
            progress = null;
        }
    }

    async function handleDelete() {
        const target = confirmDelete;
        confirmDelete = null;
        if (!target) return;
        try {
            await deleteRemoteBackup(provider.id, target.id);
            toasts.success(`Moved the backup to the bin in ${provider.name}`);
            await loadBackups();
        } catch (error) {
            toasts.error(`Could not delete the backup: ${message(error)}`);
        }
    }

    async function handleUnlink() {
        confirmUnlink = false;
        try {
            await unlinkProvider(provider.id);
            toasts.success(`Unlinked ${provider.name}`);
        } catch (error) {
            toasts.error(`Could not unlink: ${message(error)}`);
        } finally {
            onChanged();
        }
    }

    function describe(backup: RemoteBackup): string {
        const parts: string[] = [];
        if (backup.device) parts.push(backup.device);
        if (backup.documentCount !== null) parts.push(plural(backup.documentCount, 'note'));
        if (backup.attachmentCount !== null) parts.push(plural(backup.attachmentCount, 'image'));
        if (backup.size !== null) parts.push(formatSize(backup.size));
        return parts.join(' • ');
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

<section class="settings-section">
    <h2 class="section-title">{provider.name}</h2>
    <div class="section-card">
        <div class="row">
            <div class="info">
                <span class="label">{provider.name} account</span>
                {#if account}
                    <span class="desc">Linked to <strong>{account.email}</strong></span>
                {:else if linking}
                    <span class="desc">Finish signing in in your browser…</span>
                {:else}
                    <span class="desc">
                        Not linked. Link an account to back up there. Oyot only sees the backups it
                        puts there.
                    </span>
                {/if}
                {#if provider.problem}
                    <span class="problem">{provider.problem}</span>
                {/if}
            </div>
            {#if account}
                <button class="btn" onclick={() => (confirmUnlink = true)} disabled={working}>
                    Unlink
                </button>
            {:else if linking}
                <button class="btn" onclick={() => void cancelLink()}>Cancel</button>
            {:else}
                <button class="btn" onclick={handleLink} disabled={busy}>Link account</button>
            {/if}
        </div>

        {#if account}
            <div class="row">
                <div class="info">
                    <span class="label">Back up to {provider.name}</span>
                    <span class="desc">
                        {progress && backingUp
                            ? describeProgress(progress)
                            : 'Every note, journal and image, in your account'}
                    </span>
                </div>
                <button class="btn" onclick={handleBackUp} disabled={busy || working}>
                    {backingUp ? 'Backing up…' : 'Back up now'}
                </button>
            </div>

            <div class="list">
                <span class="list-title">In your {provider.name}</span>
                {#if !listed}
                    <span class="list-note">Loading…</span>
                {:else if listError}
                    <span class="problem">{listError}</span>
                {:else if backups.length === 0}
                    <span class="list-note">No backups here yet.</span>
                {:else}
                    {#each backups as backup (backup.id)}
                        <div class="backup">
                            <div class="info">
                                <span class="backup-when">{fullDate(backup.createdAt)}</span>
                                <span class="desc">
                                    {restoringId === backup.id && progress
                                        ? describeProgress(progress)
                                        : describe(backup)}
                                </span>
                            </div>
                            <div class="actions">
                                <button
                                    class="btn small"
                                    onclick={() => handleRestore(backup)}
                                    disabled={busy || working}
                                >
                                    {restoringId === backup.id ? 'Opening…' : 'Restore'}
                                </button>
                                <button
                                    class="btn small danger"
                                    onclick={() => (confirmDelete = backup)}
                                    disabled={busy || working}
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    {/each}
                {/if}
            </div>
        {/if}
    </div>
</section>

{#if confirmUnlink && account}
    <Modal title={`Unlink ${account.email}?`} onClose={() => (confirmUnlink = false)}>
        <p class="modal-note">
            Oyot stops backing up to {provider.name}, and its access to your account is withdrawn.
            Backups already there stay where they are, and you can link again at any time. Scheduled
            backups to {provider.name} pause until an account is linked again.
        </p>
        {#snippet actions()}
            <button class="btn" data-secondary onclick={() => (confirmUnlink = false)}
                >Cancel</button
            >
            <button class="btn danger-fill" onclick={handleUnlink}>Unlink</button>
        {/snippet}
    </Modal>
{/if}

{#if confirmDelete}
    <Modal title="Delete this backup?" onClose={() => (confirmDelete = null)}>
        <p class="modal-note">
            The backup from {fullDate(confirmDelete.createdAt)} moves to the bin in {provider.name},
            where it can still be restored for a while. Nothing on this device changes.
        </p>
        {#snippet actions()}
            <button class="btn" data-secondary onclick={() => (confirmDelete = null)}>Cancel</button
            >
            <button class="btn danger-fill" onclick={handleDelete}>Delete</button>
        {/snippet}
    </Modal>
{/if}

<style>
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

    .row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 16px;
    }

    .row + .row,
    .list {
        border-top: 1px solid var(--border-color);
    }

    .info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }

    .label {
        font-weight: 500;
        color: var(--text-primary);
        font-size: 15px;
    }

    .desc {
        font-size: 13px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }

    .desc strong {
        color: var(--text-secondary);
        font-weight: 500;
    }

    .problem {
        font-size: 13px;
        color: var(--status-error);
        overflow-wrap: anywhere;
    }

    .list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px 16px 16px;
    }

    .list-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .list-note {
        font-size: 13px;
        color: var(--text-muted);
    }

    .backup {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
    }

    .backup + .backup {
        border-top: 1px solid var(--border-color);
    }

    .backup-when {
        font-size: 14px;
        color: var(--text-primary);
    }

    .actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
    }

    .btn {
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

    .btn:hover:not(:disabled) {
        background: var(--bg-hover);
    }

    .btn:disabled {
        cursor: default;
        color: var(--text-muted);
    }

    .btn.small {
        padding: 6px 12px;
        font-size: 13px;
        border-radius: 8px;
    }

    .btn.danger {
        color: var(--status-error);
    }

    .btn.danger:disabled {
        color: var(--text-muted);
    }

    .btn.danger-fill {
        background: var(--status-error);
        border-color: var(--status-error);
        color: white;
    }

    .modal-note {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--text-secondary);
    }
</style>
