import { describe, it, expect } from 'vitest';
import {
    addMonths,
    formatJournalTitle,
    journalDateOf,
    isSameDay,
    journalTitleFor,
    journalTitleForDay,
    monthGrid,
    monthLabel,
    weekdayName,
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

describe('weekdayName', () => {
    it('spells out the day a date falls on', () => {
        expect(weekdayName(new Date(2026, 8, 14))).toBe('Monday');
        expect(weekdayName(new Date(2026, 8, 13))).toBe('Sunday');
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

describe('formatJournalTitle', () => {
    const today = new Date(2026, 8, 14); // 14 Sep 2026

    it('names today and yesterday', () => {
        expect(formatJournalTitle('2026-09-14', today)).toBe('Today');
        expect(formatJournalTitle('2026-09-13', today)).toBe('Yesterday');
    });

    // Crossing a month boundary is where subtracting a day by arithmetic on
    // the day number alone would produce the 0th of September.
    it('names yesterday across a month boundary', () => {
        expect(formatJournalTitle('2026-08-31', new Date(2026, 8, 1))).toBe('Yesterday');
    });

    it('spells out any other date', () => {
        expect(formatJournalTitle('2026-09-01', today)).toBe('1 Sep 2026');
        expect(formatJournalTitle('2025-12-25', today)).toBe('25 Dec 2025');
    });

    // The title is only a date because the code that creates journals makes it
    // one. Anything else is still somebody's heading and has to stay readable.
    it('leaves a title that is not a date alone', () => {
        expect(formatJournalTitle('Groceries', today)).toBe('Groceries');
        expect(formatJournalTitle('2026-9-1', today)).toBe('2026-9-1');
        expect(formatJournalTitle('', today)).toBe('');
    });

    // `new Date(2026, 1, 31)` is the 3rd of March, so a naive parse would
    // render this as "3 Mar 2026" and claim a day the title never named.
    it('leaves an impossible date alone', () => {
        expect(formatJournalTitle('2026-02-31', today)).toBe('2026-02-31');
    });
});

describe('journalDateOf', () => {
    it('reads the day a title names', () => {
        const date = journalDateOf('2026-09-14')!;
        expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 14]);
    });

    // The calendar moves to the month of whatever journal is open, so a title
    // it cannot read has to be nothing rather than a guess.
    it('has no day for a title that is not a date', () => {
        expect(journalDateOf('Groceries')).toBeNull();
        expect(journalDateOf('2026-9-1')).toBeNull();
        expect(journalDateOf('')).toBeNull();
    });

    // `new Date(2026, 1, 31)` is the 3rd of March, which would send the
    // calendar to a month the title never named.
    it('has no day for a date that does not exist', () => {
        expect(journalDateOf('2026-02-31')).toBeNull();
    });

    it('round-trips with journalTitleFor', () => {
        for (const title of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-12-31']) {
            expect(journalTitleFor(journalDateOf(title)!)).toBe(title);
        }
    });
});
