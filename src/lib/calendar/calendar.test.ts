import { describe, it, expect } from 'vitest';
import {
    addMonths,
    isSameDay,
    journalTitleFor,
    journalTitleForDay,
    monthGrid,
    monthLabel,
} from './calendar';

describe('journalTitleFor', () => {
    it('names the local day, not the UTC one', () => {
        // Late evening local time is already the next day in UTC for anyone
        // east of it, and `toISOString` would name that day instead. A
        // journal's id comes from this title, so being wrong here means two
        // devices disagreeing about which day an entry belongs to.
        const lateEvening = new Date(2026, 8, 14, 23, 30);
        expect(journalTitleFor(lateEvening)).toBe('2026-09-14');
    });

    it('pads single-digit months and days', () => {
        expect(journalTitleFor(new Date(2026, 0, 5))).toBe('2026-01-05');
    });

    it('builds a title for a day of the displayed month', () => {
        expect(journalTitleForDay(new Date(2026, 1, 20), 3)).toBe('2026-02-03');
    });
});

describe('monthGrid', () => {
    it('pads to whole weeks', () => {
        for (const month of [0, 1, 5, 11]) {
            const cells = monthGrid(new Date(2026, month, 1));
            expect(cells.length % 7).toBe(0);
        }
    });

    it('starts the month on the right weekday', () => {
        // 1 Feb 2026 is a Sunday, so there are no leading blanks.
        const feb = monthGrid(new Date(2026, 1, 1));
        expect(feb[0]).toBe(1);

        // 1 Sep 2026 is a Tuesday: two blanks before it.
        const sep = monthGrid(new Date(2026, 8, 1));
        expect(sep.slice(0, 3)).toEqual([null, null, 1]);
    });

    it('covers every day of the month exactly once', () => {
        const cells = monthGrid(new Date(2026, 1, 1));
        const days = cells.filter((c): c is number => c !== null);
        expect(days).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    });

    it('handles a leap February', () => {
        const days = monthGrid(new Date(2028, 1, 1)).filter((c) => c !== null);
        expect(days).toHaveLength(29);
    });
});

describe('addMonths', () => {
    it('rolls over a year boundary in both directions', () => {
        expect(monthLabel(addMonths(new Date(2026, 11, 15), 1))).toBe('January 2027');
        expect(monthLabel(addMonths(new Date(2026, 0, 15), -1))).toBe('December 2025');
    });

    it('does not land on an invalid day', () => {
        // Stepping from the 31st into a shorter month must not overflow into
        // the next one, which is why the result is always the first.
        const next = addMonths(new Date(2026, 0, 31), 1);
        expect(monthLabel(next)).toBe('February 2026');
        expect(next.getDate()).toBe(1);
    });
});

describe('isSameDay', () => {
    const today = new Date(2026, 8, 14);

    it('matches only the same day of the same month', () => {
        expect(isSameDay(new Date(2026, 8, 1), 14, today)).toBe(true);
        expect(isSameDay(new Date(2026, 8, 1), 13, today)).toBe(false);
        expect(isSameDay(new Date(2026, 7, 1), 14, today)).toBe(false);
        expect(isSameDay(new Date(2025, 8, 1), 14, today)).toBe(false);
    });

    it('is false for a blank cell', () => {
        expect(isSameDay(new Date(2026, 8, 1), null, today)).toBe(false);
    });
});
