import { invoke } from '@tauri-apps/api/core';
import type { Frequency, ScheduleView } from './scheduleText';

/**
 * Scheduled backups, as the settings page sets them (ADR 0026). The backups
 * themselves are made by Rust, on its own clock, whether or not this page is
 * open.
 */

interface RawScheduleView {
    frequency: Frequency;
    time_of_day: number;
    weekday: number;
    destination: string | null;
    destination_label: string | null;
    folder_label: string | null;
    skip_unchanged: boolean;
    keep: number;
    next_run_at: number | null;
    due: boolean;
    paused: string | null;
    failures: number;
    last_error: string | null;
    folders_supported: boolean;
    suggestion_dismissed: boolean;
}

function toView(raw: RawScheduleView): ScheduleView {
    return {
        frequency: raw.frequency,
        timeOfDay: raw.time_of_day,
        weekday: raw.weekday,
        destination: raw.destination,
        destinationLabel: raw.destination_label,
        folderLabel: raw.folder_label,
        skipUnchanged: raw.skip_unchanged,
        keep: raw.keep,
        nextRunAt: raw.next_run_at,
        due: raw.due,
        paused: raw.paused,
        failures: raw.failures,
        lastError: raw.last_error,
        foldersSupported: raw.folders_supported,
        suggestionDismissed: raw.suggestion_dismissed,
    };
}

/** Everything the page sets. The folder is not among it: only a dialog Rust opens sets that. */
export interface ScheduleSettings {
    frequency: Frequency;
    timeOfDay: number;
    weekday: number;
    destination: string | null;
    skipUnchanged: boolean;
    keep: number;
}

export function settingsOf(view: ScheduleView): ScheduleSettings {
    return {
        frequency: view.frequency,
        timeOfDay: view.timeOfDay,
        weekday: view.weekday,
        destination: view.destination,
        skipUnchanged: view.skipUnchanged,
        keep: view.keep,
    };
}

export async function getBackupSchedule(): Promise<ScheduleView> {
    return toView(await invoke<RawScheduleView>('get_backup_schedule'));
}

/** Save the schedule. Rejects, with a message worth showing, when it cannot be. */
export async function setBackupSchedule(settings: ScheduleSettings): Promise<ScheduleView> {
    return toView(await invoke<RawScheduleView>('set_backup_schedule', { settings }));
}

/**
 * Let the user pick the folder scheduled backups go to, and make it where
 * they go. Resolves to null when they close the dialog. Computers only.
 */
export async function chooseBackupFolder(): Promise<ScheduleView | null> {
    const raw = await invoke<RawScheduleView | null>('choose_backup_folder');
    return raw ? toView(raw) : null;
}

/** Do not suggest turning scheduled backups on again. */
export async function dismissBackupSuggestion(): Promise<void> {
    await invoke('dismiss_backup_suggestion');
}
