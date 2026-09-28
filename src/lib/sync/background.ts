// A phone's background sync, as the sync settings show it (ADR 0034).
//
// Rust runs it and records every run; this reads the two settings and the
// newest run, and says in words what they mean.

import { invoke } from '@tauri-apps/api/core';
import { formatLastSync } from '$lib/stores/sync';

/** One background run, as `sync_runs` records it. */
export interface BackgroundRun {
    /** `workmanager`, `app-refresh`, `processing` or `leaving`. */
    trigger: string;
    startedAt: number;
    endedAt: number;
    /** The display names of the devices it reached. */
    reached: string[];
    docsReceived: number;
    docsSent: number;
    imagesReceived: number;
    imagesSent: number;
    /** `synced`, `partial`, `unreachable`, `cancelled` or `failed`. */
    outcome: string;
    error: string | null;
}

export interface BackgroundSync {
    /** Only a phone syncs in the background; a desktop keeps running instead. */
    supported: boolean;
    enabled: boolean;
    mobileData: boolean;
    lastRun: BackgroundRun | null;
}

export function getBackgroundSync(): Promise<BackgroundSync> {
    return invoke<BackgroundSync>('get_background_sync');
}

export function setBackgroundSync(enabled: boolean): Promise<void> {
    return invoke<void>('set_background_sync', { enabled });
}

export function setBackgroundSyncMobileData(allowed: boolean): Promise<void> {
    return invoke<void>('set_background_sync_mobile_data', { allowed });
}

function list(names: string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function count(n: number, one: string): string {
    return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * The last background run in a sentence: when, with which device, and how
 * it went. Without it, "background sync is broken" and "the system has not
 * run it today" look the same.
 */
export function describeLastRun(run: BackgroundRun | null, now: number = Date.now()): string {
    if (!run) return 'No background sync yet.';
    const ago = formatLastSync(run.endedAt, now);
    const when = ago === 'Just now' ? 'just now' : ago;
    const with_ = run.reached.length > 0 ? `, with ${list(run.reached)}` : '';
    const moved = [
        run.docsReceived > 0 ? `${count(run.docsReceived, 'note')} received` : '',
        run.docsSent > 0 ? `${count(run.docsSent, 'note')} sent` : '',
        run.imagesReceived + run.imagesSent > 0
            ? count(run.imagesReceived + run.imagesSent, 'image') + ' moved'
            : '',
    ].filter(Boolean);
    const detail = moved.length > 0 ? ` ${moved.join(', ')}.` : '';
    switch (run.outcome) {
        case 'synced':
            return `Last background sync ${when}${with_}.${detail}`;
        case 'partial':
            return `Last background sync ${when}${with_}. Time ran out before it finished.${detail}`;
        case 'unreachable':
            return `Last background sync ${when}. No paired device could be reached.`;
        case 'cancelled':
            return `Last background sync ${when}${with_}. The system stopped it early.${detail}`;
        default:
            return `Last background sync ${when} failed${run.error ? `: ${run.error}` : '.'}`;
    }
}

/**
 * When a phone's system runs it, in plain words (ADR 0034, decision 4):
 * the 30 minutes is a request, and each system decides.
 */
export function scheduleNote(platform: string): string {
    const awake =
        'It syncs with a device that is awake, such as a computer running Oyot. Opening Oyot always syncs straight away.';
    if (platform === 'ios') {
        return `iOS decides when it runs, from how often you use Oyot, and on some days it may not run at all. After you swipe Oyot away, nothing runs until you open it again. ${awake}`;
    }
    return `Android runs it about every 30 minutes when it can, and less often for an app you rarely open. ${awake}`;
}
