import { invoke } from '@tauri-apps/api/core';
import { toPreview, type BackupPreview, type RawBackupPreview } from './backup';

export { BACKUP_PROGRESS_EVENT, describeProgress, type BackupProgress } from './progress';

/**
 * Backing up to a linked account, as the settings page uses it (ADR 0025).
 * Everything that touches the account happens in Rust; this side sees who is
 * linked and what backups are there, and never a token.
 */

export interface LinkedAccount {
    email: string;
    name: string | null;
}

export interface BackupProvider {
    id: string;
    name: string;
    account: LinkedAccount | null;
    /** Why the link could not be read, when it could not. */
    problem: string | null;
}

export interface RemoteBackup {
    id: string;
    name: string;
    size: number | null;
    /** When the backup was taken. */
    createdAt: number;
    device: string | null;
    documentCount: number | null;
    attachmentCount: number | null;
}

export interface RemoteBackupResult {
    destinationLabel: string;
    documentCount: number;
    attachmentCount: number;
    skippedAttachments: number;
    skippedDocuments: string[];
    sizeBytes: number;
    backup: RemoteBackup;
}

interface RawRemoteBackup {
    id: string;
    name: string;
    size: number | null;
    created_at: number;
    device: string | null;
    document_count: number | null;
    attachment_count: number | null;
}

function toRemoteBackup(raw: RawRemoteBackup): RemoteBackup {
    return {
        id: raw.id,
        name: raw.name,
        size: raw.size,
        createdAt: raw.created_at,
        device: raw.device,
        documentCount: raw.document_count,
        attachmentCount: raw.attachment_count,
    };
}

/** Every provider this build can back up to. Empty in a build without credentials for any. */
export async function listProviders(): Promise<BackupProvider[]> {
    return invoke<BackupProvider[]>('list_backup_providers');
}

/**
 * Link an account. Rust opens the sign-in in the system browser, and this
 * resolves when the user finishes there; it rejects if they decline, take too
 * long, or `cancelLink` is called.
 */
export async function linkProvider(provider: string): Promise<LinkedAccount> {
    return invoke<LinkedAccount>('link_backup_provider', { provider });
}

export async function cancelLink(): Promise<void> {
    await invoke('cancel_backup_link');
}

export async function unlinkProvider(provider: string): Promise<void> {
    await invoke('unlink_backup_provider', { provider });
}

export async function backUpToProvider(provider: string): Promise<RemoteBackupResult> {
    const raw = await invoke<{
        destination_label: string;
        document_count: number;
        attachment_count: number;
        skipped_attachments: number;
        skipped_documents: string[];
        size_bytes: number;
        backup: RawRemoteBackup;
    }>('create_remote_backup', { provider });
    return {
        destinationLabel: raw.destination_label,
        documentCount: raw.document_count,
        attachmentCount: raw.attachment_count,
        skippedAttachments: raw.skipped_attachments,
        skippedDocuments: raw.skipped_documents,
        sizeBytes: raw.size_bytes,
        backup: toRemoteBackup(raw.backup),
    };
}

export async function listRemoteBackups(provider: string): Promise<RemoteBackup[]> {
    const rows = await invoke<RawRemoteBackup[]>('list_remote_backups', { provider });
    return rows.map(toRemoteBackup);
}

/** Download a backup and have Rust check all of it, ready to import like a file from disk. */
export async function openRemoteBackup(provider: string, backupId: string): Promise<BackupPreview> {
    const raw = await invoke<RawBackupPreview>('open_remote_backup', { provider, backupId });
    return toPreview(raw);
}

export async function deleteRemoteBackup(provider: string, backupId: string): Promise<void> {
    await invoke('delete_remote_backup', { provider, backupId });
}
