/** Emitted by Rust while a backup moves to or from a provider. */
export const BACKUP_PROGRESS_EVENT = 'backup-progress';

export interface BackupProgress {
    phase: 'building' | 'uploading' | 'downloading';
    done: number;
    /** 0 when not known. */
    total: number;
}

/** How far a transfer has got, in words. */
export function describeProgress(progress: BackupProgress): string {
    const percent =
        progress.total > 0
            ? Math.min(100, Math.floor((progress.done / progress.total) * 100))
            : null;
    switch (progress.phase) {
        case 'building':
            return 'Preparing the backup…';
        case 'uploading':
            return percent === null ? 'Uploading…' : `Uploading… ${percent}%`;
        case 'downloading':
            return percent === null ? 'Downloading…' : `Downloading… ${percent}%`;
    }
}
