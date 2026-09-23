import type { BackupRecord } from './backup';
import type { BackupProvider } from './remote';

/**
 * What the settings page and the rest of the app say about scheduled backups
 * (ADR 0026). Nothing here calls Rust, so it is tested as it is.
 */

export type Frequency = 'off' | 'daily' | 'weekly';

/** The destination that is a folder on this computer, as opposed to a provider's id. */
export const FOLDER = 'folder';

/** Scheduled failures in a row before the app says so outside the settings page. */
export const FAILURES_WORTH_A_WARNING = 3;

export const WEEKDAYS = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
] as const;

export interface ScheduleView {
    frequency: Frequency;
    /** Minutes after local midnight. */
    timeOfDay: number;
    /** 0 is Monday. */
    weekday: number;
    /** `folder`, or a provider's id. */
    destination: string | null;
    /** The folder's name, or the provider and its account. */
    destinationLabel: string | null;
    /** The chosen folder's name. Its path never leaves Rust. */
    folderLabel: string | null;
    skipUnchanged: boolean;
    keep: number;
    /** When the next scheduled backup is due. Null when off or paused. */
    nextRunAt: number | null;
    /** A backup is owed now, and starts within a few minutes. */
    due: boolean;
    /** Why scheduled backups cannot run, when the schedule is on and they cannot. */
    paused: string | null;
    /** Scheduled attempts that have failed in a row. */
    failures: number;
    lastError: string | null;
    /** Whether this device can back up to a folder on a schedule: computers only. */
    foldersSupported: boolean;
    suggestionDismissed: boolean;
}

/** "02:00", as a time input holds it. */
export function toTimeInput(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Minutes after midnight, from what a time input holds; null when it holds nothing usable. */
export function fromTimeInput(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
}

function clock(at: Date): string {
    return toTimeInput(at.getHours() * 60 + at.getMinutes());
}

function startOfDay(at: Date): number {
    return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** "today at 14:05", "tomorrow at 02:00", "on Friday at 18:30", "on 3 Oct at 02:00". */
export function when(at: number, now: number): string {
    const target = new Date(at);
    const days = Math.round((startOfDay(target) - startOfDay(new Date(now))) / 86_400_000);
    const time = clock(target);
    if (days <= 0) return `today at ${time}`;
    if (days === 1) return `tomorrow at ${time}`;
    if (days < 7) return `on ${WEEKDAYS[(target.getDay() + 6) % 7]} at ${time}`;
    // Spelled out here rather than by toLocaleDateString, whose short month
    // names differ between ICU versions ("Sep", "Sept").
    return `on ${target.getDate()} ${MONTHS[target.getMonth()]} at ${time}`;
}

const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
] as const;

/** The one line the page shows about what the schedule will do next, or null when it is off. */
export function describeNextRun(view: ScheduleView, now: number): string | null {
    if (view.frequency === 'off') return null;
    if (view.paused) return `Scheduled backups are paused. ${view.paused}`;
    if (view.due) return 'A scheduled backup is due, and starts within a few minutes.';
    if (view.nextRunAt === null) return null;
    if (view.failures > 0) {
        return (
            `The last ${plural(view.failures, 'scheduled backup')} failed. ` +
            `Trying again ${when(view.nextRunAt, now)}.`
        );
    }
    return `Next backup ${when(view.nextRunAt, now)}.`;
}

/**
 * A warning worth raising outside the settings page, where a failing
 * schedule would otherwise go unnoticed (ADR 0026, decision 4): one that has
 * failed several times in a row, or one that has stopped because its account
 * is no longer linked.
 */
export function backupWarning(view: ScheduleView): string | null {
    if (view.frequency === 'off') return null;
    if (view.paused) {
        return `Scheduled backups are paused. ${view.paused} Open Settings, then Backup.`;
    }
    if (view.failures >= FAILURES_WORTH_A_WARNING) {
        const reason = view.lastError ? `: ${sentence(view.lastError)}` : '.';
        return (
            `Scheduled backups have failed ${view.failures} times in a row${reason} ` +
            'Open Settings, then Backup.'
        );
    }
    return null;
}

/** An error as the end of a sentence. Some arrive with a full stop and some without. */
function sentence(text: string): string {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The provider to suggest scheduled backups to: shown once an account is
 * linked while the schedule is off, until it is turned on or dismissed.
 */
export function suggestion(view: ScheduleView, providers: BackupProvider[]): BackupProvider | null {
    if (view.frequency !== 'off' || view.suggestionDismissed) return null;
    return providers.find((p) => p.account !== null) ?? null;
}

/** One line of the history: an attempt, or a run of scheduled failures shown as one. */
export interface HistoryEntry {
    record: BackupRecord;
    /** How many scheduled attempts in a row failed, when this stands for several. */
    failedTimes: number;
}

/**
 * The history as the page lists it, newest first. Retries are rows too, and
 * a failing schedule adds one an hour, so consecutive scheduled failures
 * are shown as one entry (ADR 0026, decision 7).
 */
export function groupHistory(records: BackupRecord[], limit: number): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    for (const record of records) {
        const previous = entries[entries.length - 1];
        if (
            previous &&
            isScheduledFailure(record) &&
            isScheduledFailure(previous.record) &&
            record.destination === previous.record.destination
        ) {
            previous.failedTimes += 1;
            continue;
        }
        if (entries.length === limit) break;
        entries.push({ record, failedTimes: 1 });
    }
    return entries;
}

function isScheduledFailure(record: BackupRecord): boolean {
    return record.scheduled && record.status === 'failed';
}

function plural(count: number, noun: string): string {
    return count === 1 ? noun : `${count} ${noun}s`;
}
