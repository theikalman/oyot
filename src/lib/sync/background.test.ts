import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { describeLastRun, scheduleNote } = await import('./background');
type BackgroundRun = import('./background').BackgroundRun;

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function run(overrides: Partial<BackgroundRun> = {}): BackgroundRun {
    return {
        trigger: 'workmanager',
        startedAt: NOW - 13 * MINUTE,
        endedAt: NOW - 12 * MINUTE,
        reached: ['Desktop'],
        docsReceived: 0,
        docsSent: 0,
        imagesReceived: 0,
        imagesSent: 0,
        outcome: 'synced',
        error: null,
        ...overrides,
    };
}

describe('the last background sync, in words', () => {
    it('says when there has been none', () => {
        expect(describeLastRun(null, NOW)).toBe('No background sync yet.');
    });

    it('says when, and with which device', () => {
        expect(describeLastRun(run(), NOW)).toBe('Last background sync 12m ago, with Desktop.');
    });

    it('says what moved, when anything did', () => {
        expect(
            describeLastRun(
                run({ docsReceived: 3, docsSent: 1, imagesReceived: 1, imagesSent: 1 }),
                NOW,
            ),
        ).toBe(
            'Last background sync 12m ago, with Desktop. 3 notes received, 1 note sent, 2 images moved.',
        );
    });

    it('names every device it reached', () => {
        expect(describeLastRun(run({ reached: ['Desktop', 'Laptop', 'Tablet'] }), NOW)).toBe(
            'Last background sync 12m ago, with Desktop, Laptop and Tablet.',
        );
    });

    // "Background sync is broken" and "nothing was there to sync with" look
    // the same without this.
    it('tells a run that found nobody from one that worked', () => {
        expect(describeLastRun(run({ reached: [], outcome: 'unreachable' }), NOW)).toBe(
            'Last background sync 12m ago. No paired device could be reached.',
        );
    });

    it('says when time ran out, or the system stopped it', () => {
        expect(describeLastRun(run({ outcome: 'partial', docsReceived: 1 }), NOW)).toBe(
            'Last background sync 12m ago, with Desktop. Time ran out before it finished. 1 note received.',
        );
        expect(describeLastRun(run({ outcome: 'cancelled' }), NOW)).toBe(
            'Last background sync 12m ago, with Desktop. The system stopped it early.',
        );
    });

    it('says why it failed', () => {
        expect(
            describeLastRun(
                run({ outcome: 'failed', reached: [], error: 'the database is locked' }),
                NOW,
            ),
        ).toBe('Last background sync 12m ago failed: the database is locked');
    });

    it('reads naturally a moment later', () => {
        expect(describeLastRun(run({ endedAt: NOW - 1_000 }), NOW)).toBe(
            'Last background sync just now, with Desktop.',
        );
    });
});

describe('when each system runs it', () => {
    it('says iOS decides, and may not run it at all', () => {
        expect(scheduleNote('ios')).toMatch(/^iOS decides when it runs/);
        expect(scheduleNote('ios')).toContain('some days it may not run at all');
    });

    it('says Android runs it about every 30 minutes', () => {
        expect(scheduleNote('android')).toMatch(/^Android runs it about every 30 minutes/);
    });

    it('says it needs a device that is awake, on both', () => {
        for (const platform of ['ios', 'android']) {
            expect(scheduleNote(platform)).toContain('a device that is awake');
        }
    });
});
