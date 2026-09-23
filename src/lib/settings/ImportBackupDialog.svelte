<script lang="ts">
    import Modal from '$lib/components/Modal.svelte';
    import type { BackupPreview, ImportPlan } from '$lib/backup';

    interface Props {
        preview: BackupPreview;
        plan: ImportPlan;
        /** Set while the import runs. */
        progress: { done: number; total: number } | null;
        onImport: () => void;
        onCancel: () => void;
    }

    let { preview, plan, progress, onImport, onCancel }: Props = $props();

    let counts = $derived(plan.counts);
    let importing = $derived(progress !== null);
    // A backup that adds nothing is still worth saying so about, rather than
    // offering an Import button that would visibly do nothing.
    let nothingNew = $derived(
        counts.added + counts.restored + counts.updated === 0 && preview.newAttachmentCount === 0,
    );
    let percent = $derived(
        progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
    );

    let made = $derived(
        new Date(preview.createdAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }),
    );

    function plural(count: number, noun: string): string {
        return `${count} ${noun}${count === 1 ? '' : 's'}`;
    }

    // Closing is refused while the import runs: it cannot be stopped part way,
    // and a dialog that vanished would look as though it had been.
    function close() {
        if (!importing) onCancel();
    }
</script>

<Modal title="Import this backup?" onClose={close}>
    <p class="source">
        Made on <strong>{preview.sourceDevice || 'another device'}</strong>, {made}.
    </p>

    {#if nothingNew}
        <p class="note">Everything in this backup is already on this device.</p>
    {:else}
        <ul class="counts">
            {#if counts.added > 0}
                <li><strong>{plural(counts.added, 'note')}</strong> not on this device</li>
            {/if}
            {#if counts.restored > 0}
                <li>
                    <strong>{plural(counts.restored, 'note')}</strong> deleted here but newer in the backup,
                    brought back
                </li>
            {/if}
            {#if counts.updated > 0}
                <li>
                    <strong>{plural(counts.updated, 'note')}</strong> that
                    {counts.updated === 1 ? 'differs' : 'differ'} from the copy here, merged together
                </li>
            {/if}
            {#if preview.newAttachmentCount > 0}
                <li>
                    <strong>{plural(preview.newAttachmentCount, 'image')}</strong> not on this device
                </li>
            {/if}
            {#if counts.unchanged > 0}
                <li class="muted">{plural(counts.unchanged, 'note')} already up to date</li>
            {/if}
        </ul>
    {/if}

    {#if counts.kept > 0}
        <p class="note">
            {plural(counts.kept, 'note')} deleted in the backup {counts.kept === 1 ? 'is' : 'are'}
            still here, and will stay.
        </p>
    {/if}
    {#if counts.staysDeleted > 0}
        <p class="note">
            {plural(counts.staysDeleted, 'note')} deleted here after the backup was made will stay deleted.
        </p>
    {/if}
    {#if !nothingNew}
        <!-- Not "or overwritten": a newer title in the backup does replace
             the one here, the same as it would from a peer. -->
        <p class="note">Nothing on this device is removed.</p>
    {/if}

    {#if progress}
        <div
            class="progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percent}
        >
            <div class="progress-bar" style:width={`${percent}%`}></div>
        </div>
        <p class="progress-label">
            {progress.total > 0 ? `Importing ${progress.done} of ${progress.total}…` : 'Importing…'}
        </p>
    {/if}

    {#snippet actions()}
        {#if nothingNew}
            <button class="btn-primary" onclick={onCancel}>Close</button>
        {:else}
            <button class="btn-secondary" data-secondary onclick={onCancel} disabled={importing}>
                Cancel
            </button>
            <button class="btn-primary" onclick={onImport} disabled={importing}>
                {importing ? 'Importing…' : 'Import'}
            </button>
        {/if}
    {/snippet}
</Modal>

<style>
    .source {
        margin: 0 0 12px 0;
        font-size: 14px;
        color: var(--text-secondary);
    }

    .source strong {
        color: var(--text-primary);
        font-weight: 500;
    }

    .counts {
        margin: 0 0 12px 0;
        padding-left: 18px;
        font-size: 14px;
        line-height: 1.6;
        color: var(--text-primary);
    }

    .counts strong {
        font-weight: 600;
    }

    .counts .muted {
        color: var(--text-muted);
    }

    .note {
        margin: 0 0 8px 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
    }

    .progress {
        height: 6px;
        margin-top: 16px;
        background: var(--bg-hover);
        border-radius: 3px;
        overflow: hidden;
    }

    .progress-bar {
        height: 100%;
        background: var(--accent-color);
        transition: width 0.15s ease-out;
    }

    .progress-label {
        margin: 8px 0 0 0;
        font-size: 13px;
        color: var(--text-secondary);
    }

    .btn-secondary {
        padding: 8px 16px;
        background: transparent;
        color: var(--text-primary);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
    }

    .btn-primary {
        padding: 8px 16px;
        background: var(--accent-color);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
    }

    .btn-secondary:disabled,
    .btn-primary:disabled {
        cursor: default;
        opacity: 0.6;
    }
</style>
