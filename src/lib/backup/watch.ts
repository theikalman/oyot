import { listen } from '@tauri-apps/api/event';
import { toasts } from '$lib/services/toast';
import { BACKUP_STATUS_EVENT } from './backup';
import { getBackupSchedule } from './schedule';
import { backupWarning } from './scheduleText';

/**
 * Say so, once a session, when scheduled backups are failing or have
 * stopped. A schedule that only shows its trouble on the settings page is
 * one nobody notices (ADR 0026, decision 4).
 *
 * Checked at startup and whenever the backup history changes. Returns how to
 * stop watching.
 */
export function watchScheduledBackups(): () => void {
    let warned = false;
    let stopped = false;
    let unlisten: (() => void) | null = null;

    const check = async () => {
        if (warned || stopped) return;
        try {
            const warning = backupWarning(await getBackupSchedule());
            if (warning && !warned && !stopped) {
                warned = true;
                // Stays until dismissed: it is the only place this shows
                // outside settings, and it appears while the app is still
                // loading, when a timed toast would be gone before it is read.
                toasts.warning(warning, 0);
                unlisten?.();
            }
        } catch (error) {
            console.warn('[backup] could not check scheduled backups:', error);
        }
    };

    void check();
    listen(BACKUP_STATUS_EVENT, () => void check())
        .then((fn) => {
            if (stopped || warned) fn();
            else unlisten = fn;
        })
        .catch((e) => console.warn('[backup] status events unavailable:', e));

    return () => {
        stopped = true;
        unlisten?.();
    };
}
