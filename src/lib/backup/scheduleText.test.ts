import { describe, it, expect } from 'vitest';
import type { BackupRecord } from './backup';
import type { BackupProvider } from './remote';
import {
    backupWarning,
    describeNextRun,
    fromTimeInput,
    groupHistory,
    suggestion,
    toTimeInput,
    when,
    type ScheduleView,
} from './scheduleText';

// Local times, so the tests read the same in any time zone. 2026-09-23 is a
// Wednesday.
const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 8, day, hour, minute).getTime();
const NOW = at(23, 9);

function view(overrides: Partial<ScheduleView> = {}): ScheduleView {
    return {
        frequency: 'daily',
        timeOfDay: 120,
        weekday: 0,
        destination: 'google-drive',
        destinationLabel: 'Google Drive (me@example.com)',
        folderLabel: null,
        skipUnchanged: true,
        keep: 10,
        nextRunAt: at(24, 2),
        due: false,
        paused: null,
        failures: 0,
        lastError: null,
        foldersSupported: true,
        suggestionDismissed: false,
        ...overrides,
    };
}

function record(id: number, overrides: Partial<BackupRecord> = {}): BackupRecord {
    return {
        id,
        scheduled: true,
        destination: 'google-drive',
        destinationLabel: 'Google Drive (me@example.com)',
        startedAt: id,
        finishedAt: id + 1,
        status: 'success',
        error: null,
        sizeBytes: 100,
        documentCount: 1,
        attachmentCount: 0,
        skippedAttachments: 0,
        skippedDocuments: 0,
        ...overrides,
    };
}

describe('time of day', () => {
    it('reads and writes what a time input holds', () => {
        expect(toTimeInput(120)).toBe('02:00');
        expect(toTimeInput(23 * 60 + 59)).toBe('23:59');
        expect(fromTimeInput('18:30')).toBe(18 * 60 + 30);
        expect(fromTimeInput('7:05')).toBe(7 * 60 + 5);
        // Some browsers add seconds.
        expect(fromTimeInput('02:00:00')).toBe(120);
    });

    it('refuses what is not a time', () => {
        expect(fromTimeInput('')).toBeNull();
        expect(fromTimeInput('24:00')).toBeNull();
        expect(fromTimeInput('12:60')).toBeNull();
        expect(fromTimeInput('noon')).toBeNull();
    });
});

describe('when', () => {
    it('says today, tomorrow, a weekday, then a date', () => {
        expect(when(at(23, 14, 5), NOW)).toBe('today at 14:05');
        expect(when(at(24, 2), NOW)).toBe('tomorrow at 02:00');
        expect(when(at(25, 18, 30), NOW)).toBe('on Friday at 18:30');
        expect(when(at(29, 2), NOW)).toBe('on Tuesday at 02:00');
        expect(when(at(30, 2), NOW)).toBe('on 30 Sep at 02:00');
    });
});

describe('describeNextRun', () => {
    it('says nothing about a schedule that is off', () => {
        expect(describeNextRun(view({ frequency: 'off', nextRunAt: null }), NOW)).toBeNull();
    });

    it('says when the next backup is', () => {
        expect(describeNextRun(view(), NOW)).toBe('Next backup tomorrow at 02:00.');
    });

    it('says a backup is about to start', () => {
        expect(describeNextRun(view({ due: true, nextRunAt: NOW }), NOW)).toBe(
            'A scheduled backup is due, and starts within a few minutes.',
        );
    });

    it('says why a schedule is paused', () => {
        const paused =
            'Google Drive is no longer linked. Link it again to resume scheduled backups.';
        expect(describeNextRun(view({ paused, nextRunAt: null }), NOW)).toBe(
            `Scheduled backups are paused. ${paused}`,
        );
    });

    it('says a failing schedule is trying again, and when', () => {
        expect(describeNextRun(view({ failures: 1, nextRunAt: at(23, 9, 5) }), NOW)).toBe(
            'The last scheduled backup failed. Trying again today at 09:05.',
        );
        expect(describeNextRun(view({ failures: 3, nextRunAt: at(23, 10) }), NOW)).toBe(
            'The last 3 scheduled backups failed. Trying again today at 10:00.',
        );
    });
});

describe('backupWarning', () => {
    it('warns once a schedule has failed several times in a row', () => {
        expect(backupWarning(view({ failures: 2, lastError: 'offline' }))).toBeNull();
        expect(backupWarning(view({ failures: 3, lastError: 'your Google Drive is full' }))).toBe(
            'Scheduled backups have failed 3 times in a row: your Google Drive is full. ' +
                'Open Settings, then Backup.',
        );
    });

    it('ends the reason as a sentence, however it arrived', () => {
        expect(
            backupWarning(
                view({ failures: 4, lastError: 'The folder "Backups" could not be found.' }),
            ),
        ).toBe(
            'Scheduled backups have failed 4 times in a row: The folder "Backups" could not be ' +
                'found. Open Settings, then Backup.',
        );
    });

    it('warns when a schedule has stopped for want of a linked account', () => {
        expect(backupWarning(view({ paused: 'Google Drive is no longer linked.' }))).toBe(
            'Scheduled backups are paused. Google Drive is no longer linked. ' +
                'Open Settings, then Backup.',
        );
    });

    it('never warns about a schedule that is off', () => {
        expect(
            backupWarning(view({ frequency: 'off', failures: 9, paused: 'Unlinked.' })),
        ).toBeNull();
    });
});

describe('suggestion', () => {
    const linked: BackupProvider = {
        id: 'google-drive',
        name: 'Google Drive',
        account: { email: 'me@example.com', name: null },
        problem: null,
    };
    const unlinked: BackupProvider = { ...linked, account: null };
    const off = view({ frequency: 'off', destination: null });

    it('suggests a schedule once an account is linked', () => {
        expect(suggestion(off, [linked])).toBe(linked);
        expect(suggestion(off, [unlinked])).toBeNull();
        expect(suggestion(off, [])).toBeNull();
    });

    it('stops suggesting once answered, or once a schedule is on', () => {
        expect(suggestion({ ...off, suggestionDismissed: true }, [linked])).toBeNull();
        expect(suggestion(view(), [linked])).toBeNull();
    });
});

describe('groupHistory', () => {
    it('shows a run of scheduled failures as one entry', () => {
        const records = [
            record(6, { status: 'failed', error: 'offline' }),
            record(5, { status: 'failed', error: 'offline' }),
            record(4, { status: 'failed', error: 'offline' }),
            record(3),
            record(2, { status: 'failed' }),
        ];
        const entries = groupHistory(records, 10);
        expect(entries.map((e) => [e.record.id, e.failedTimes])).toEqual([
            [6, 3],
            [3, 1],
            [2, 1],
        ]);
    });

    it('keeps manual failures, and failures at different places, apart', () => {
        const records = [
            record(3, { status: 'failed', scheduled: false }),
            record(2, { status: 'failed' }),
            record(1, { status: 'failed', destination: 'folder' }),
        ];
        expect(groupHistory(records, 10).map((e) => e.failedTimes)).toEqual([1, 1, 1]);
    });

    it('stops at the limit, but finishes counting the last run', () => {
        const records = [
            record(4),
            record(3, { status: 'failed' }),
            record(2, { status: 'failed' }),
            record(1),
        ];
        expect(groupHistory(records, 2).map((e) => [e.record.id, e.failedTimes])).toEqual([
            [4, 1],
            [3, 2],
        ]);
    });
});
