import { invoke } from '@tauri-apps/api/core';
import {
    documentRepository,
    broadcastDocCreated,
    broadcastDocRenamed,
    broadcastLocalUpdate,
} from '$lib/sync';
import { toManifestEntry, type RawSyncEntry } from '$lib/sync/DocumentRepository';
import { lifecycleStamp, type ManifestEntry } from '$lib/sync/protocol';
import { appStore } from '$lib/stores/app';
import { saveTheme } from '$lib/services/theme';
import type { Theme } from '$lib/types';
import {
    applyImport,
    planImport,
    type ImportAnnouncer,
    type ImportPlan,
    type ImportResult,
} from './importBackup';

/**
 * Backing up to a file and importing one back, as the settings page uses
 * them. The file work is Rust's (commands/backup.rs); the merge is this
 * side's, because only this side can read a document (ADR 0024).
 */

/** Emitted by Rust whenever the backup history changes. */
export const BACKUP_STATUS_EVENT = 'backup-status-changed';

// --- backing up --------------------------------------------------------------

interface RawLocalBackupResult {
    file_name: string;
    document_count: number;
    attachment_count: number;
    skipped_attachments: number;
    skipped_documents: string[];
    size_bytes: number;
}

export interface LocalBackupResult {
    fileName: string;
    documentCount: number;
    attachmentCount: number;
    /** Images a note embeds that could not be included. */
    skippedAttachments: number;
    /** Titles of documents whose content could not be included. */
    skippedDocuments: string[];
    sizeBytes: number;
}

/**
 * Back up everything to a file the user picks. Resolves to null when they
 * close the dialog.
 *
 * The editor needs no flushing first: this is only reachable from settings,
 * and leaving the editor to get there already wrote its pending save.
 */
export async function backUpToFile(): Promise<LocalBackupResult | null> {
    const raw = await invoke<RawLocalBackupResult | null>('create_local_backup');
    if (!raw) return null;
    return {
        fileName: raw.file_name,
        documentCount: raw.document_count,
        attachmentCount: raw.attachment_count,
        skippedAttachments: raw.skipped_attachments,
        skippedDocuments: raw.skipped_documents,
        sizeBytes: raw.size_bytes,
    };
}

// --- status ------------------------------------------------------------------

interface RawBackupRecord {
    id: number;
    scheduled: boolean;
    destination: string;
    destination_label: string;
    started_at: number;
    finished_at: number | null;
    status: BackupRecord['status'];
    error: string | null;
    size_bytes: number | null;
    document_count: number | null;
    attachment_count: number | null;
    skipped_attachments: number | null;
    skipped_documents: number | null;
}

export interface BackupRecord {
    id: number;
    scheduled: boolean;
    /** `local`, or a provider's id. */
    destination: string;
    /** A file name, or an account. */
    destinationLabel: string;
    startedAt: number;
    finishedAt: number | null;
    status: 'running' | 'success' | 'failed' | 'skipped';
    error: string | null;
    sizeBytes: number | null;
    documentCount: number | null;
    attachmentCount: number | null;
    skippedAttachments: number | null;
    skippedDocuments: number | null;
}

export interface BackupStatus {
    lastSuccess: BackupRecord | null;
    /** The newest attempt when it is not `lastSuccess`: a failure, or one running. */
    latestAttempt: BackupRecord | null;
    running: boolean;
}

function toRecord(raw: RawBackupRecord): BackupRecord {
    return {
        id: raw.id,
        scheduled: raw.scheduled,
        destination: raw.destination,
        destinationLabel: raw.destination_label,
        startedAt: raw.started_at,
        finishedAt: raw.finished_at,
        status: raw.status,
        error: raw.error,
        sizeBytes: raw.size_bytes,
        documentCount: raw.document_count,
        attachmentCount: raw.attachment_count,
        skippedAttachments: raw.skipped_attachments,
        skippedDocuments: raw.skipped_documents,
    };
}

export async function getBackupStatus(): Promise<BackupStatus> {
    const raw = await invoke<{
        last_success: RawBackupRecord | null;
        latest_attempt: RawBackupRecord | null;
        running: boolean;
    }>('get_backup_status');
    return {
        lastSuccess: raw.last_success ? toRecord(raw.last_success) : null,
        latestAttempt: raw.latest_attempt ? toRecord(raw.latest_attempt) : null,
        running: raw.running,
    };
}

export async function listBackupHistory(limit = 10): Promise<BackupRecord[]> {
    const rows = await invoke<RawBackupRecord[]>('list_backup_history', { limit });
    return rows.map(toRecord);
}

// --- importing ---------------------------------------------------------------

interface RawBackupPreview {
    session_id: string;
    created_at: number;
    source_device: string;
    app_version: string;
    document_count: number;
    attachment_count: number;
    new_attachment_count: number;
    theme: string | null;
    documents: RawSyncEntry[];
}

/** A backup that has been opened and checked, before anything is imported. */
export interface BackupPreview {
    sessionId: string;
    createdAt: number;
    sourceDevice: string;
    appVersion: string;
    documentCount: number;
    attachmentCount: number;
    /** Images in the backup this device does not hold. */
    newAttachmentCount: number;
    theme: Theme | null;
    documents: ManifestEntry[];
}

/**
 * Let the user pick a backup, and have Rust check all of it. Resolves to
 * null when they close the dialog; rejects, with a message worth showing,
 * when the file is not a backup this build can read.
 */
export async function openBackupFile(): Promise<BackupPreview | null> {
    const raw = await invoke<RawBackupPreview | null>('open_local_backup');
    if (!raw) return null;
    return {
        sessionId: raw.session_id,
        createdAt: raw.created_at,
        sourceDevice: raw.source_device,
        appVersion: raw.app_version,
        documentCount: raw.document_count,
        attachmentCount: raw.attachment_count,
        newAttachmentCount: raw.new_attachment_count,
        theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : null,
        documents: raw.documents.map(toManifestEntry),
    };
}

/** What importing this backup would do, against this device as it is now. */
export async function planBackupImport(preview: BackupPreview): Promise<ImportPlan> {
    const local = await documentRepository.listSyncState();
    return planImport(preview.documents, local);
}

export interface BackupImportResult extends ImportResult {
    imagesImported: number;
    imagesFailed: number;
    /** Whether the backup's theme was taken, which it is only on a device that never chose one. */
    themeApplied: boolean;
}

const announce: ImportAnnouncer = {
    created: (entry) =>
        broadcastDocCreated({
            id: entry.id,
            docType: entry.docType,
            title: entry.title,
            titleUpdatedAt: entry.titleUpdatedAt,
            createdAt: entry.createdAt,
            lifecycleUpdatedAt: lifecycleStamp(entry),
        }),
    updated: (docId, state) => broadcastLocalUpdate(docId, state),
    renamed: (docId, title, titleUpdatedAt) => broadcastDocRenamed(docId, title, titleUpdatedAt),
};

/**
 * Import an opened backup. Documents first, then images: an image arriving
 * before the note that embeds it would sit unreferenced, which is exactly
 * what the attachment collector looks for.
 *
 * The backup is closed however this ends.
 */
export async function importBackup(
    preview: BackupPreview,
    plan: ImportPlan,
    onProgress: (done: number, total: number) => void,
): Promise<BackupImportResult> {
    const { sessionId } = preview;
    try {
        const documents = await applyImport(
            plan,
            (docId) => invoke<string | null>('backup_session_read_state', { sessionId, docId }),
            documentRepository,
            announce,
            onProgress,
        );
        const images = await invoke<{ imported: number; already_here: number; failed: number }>(
            'backup_session_import_attachments',
            { sessionId },
        );
        return {
            ...documents,
            imagesImported: images.imported,
            imagesFailed: images.failed,
            themeApplied: await adoptTheme(preview.theme),
        };
    } finally {
        await closeBackup(preview);
    }
}

/** Close an opened backup without importing it. */
export async function closeBackup(preview: BackupPreview): Promise<void> {
    try {
        await invoke('close_backup_session', { sessionId: preview.sessionId });
    } catch (e) {
        console.warn('[backup] could not close the backup:', e);
    }
}

/**
 * Take the backup's theme, but only on a device where nobody has chosen one:
 * an import fills in what is missing and overrides nothing, preferences
 * included.
 */
async function adoptTheme(theme: Theme | null): Promise<boolean> {
    if (!theme) return false;
    try {
        const chosen = await invoke<string | null>('get_theme');
        if (chosen !== null) return false;
        appStore.setTheme(theme);
        await saveTheme(theme);
        return true;
    } catch (e) {
        console.warn('[backup] could not apply the backup theme:', e);
        return false;
    }
}
