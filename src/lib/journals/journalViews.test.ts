import { describe, expect, it } from 'vitest';
import type { JournalEntry } from './journalIndex';
import { listRows, monthCells, shortStatus, yearStrip, zoomView } from './journalViews';

function entry(title: string, over: Partial<JournalEntry> = {}): JournalEntry {
    const [y, m, d] = title.split('-').map(Number);
    return {
        id: title,
        title,
        date: new Date(y, m - 1, d),
        todoCount: 0,
        openTodoCount: 0,
        hasContent: true,
        tags: [],
        ...over,
    };
}

describe('zoomView', () => {
    it('steps out from the list to the month to the year, and stops there', () => {
        expect(zoomView('list', true)).toBe('month');
        expect(zoomView('month', true)).toBe('year');
        expect(zoomView('year', true)).toBe('year');
        expect(zoomView('year', false)).toBe('month');
        expect(zoomView('list', false)).toBe('list');
    });
});

describe('listRows', () => {
    it('folds a run of empty days into one line, oldest to newest', () => {
        const rows = listRows([
            entry('2026-10-16'),
            entry('2026-10-15', { hasContent: false }),
            entry('2026-10-14', { hasContent: false }),
            entry('2026-10-13'),
        ]);
        expect(rows.map((r) => r.kind)).toEqual(['day', 'gap', 'day']);
        expect(rows[1]).toMatchObject({ label: 'Wednesday 14 to Thursday 15', count: 2 });
    });

    it('names a single empty day alone', () => {
        const rows = listRows([entry('2026-10-18', { hasContent: false })]);
        expect(rows[0]).toMatchObject({ kind: 'gap', label: 'Sunday 18', count: 1 });
    });

    it('keeps a day with an open todo, even with nothing else written', () => {
        const rows = listRows([entry('2026-10-26', { hasContent: false, openTodoCount: 1 })]);
        expect(rows[0].kind).toBe('day');
    });
});

describe('shortStatus', () => {
    it('says what is open, or what is done, or nothing', () => {
        expect(shortStatus(entry('2026-10-24', { todoCount: 28, openTodoCount: 28 }))).toEqual({
            text: '28 open',
            tone: 'todo',
        });
        expect(shortStatus(entry('2026-10-20', { todoCount: 2 }))).toEqual({
            text: '2 done',
            tone: 'ok',
        });
        expect(shortStatus(entry('2026-10-21'))).toBeNull();
    });
});

describe('monthCells', () => {
    it('starts the month on its weekday and marks what each day holds', () => {
        const today = new Date(2026, 9, 24);
        const cells = monthCells(
            2026,
            9,
            [entry('2026-10-01'), entry('2026-10-26', { openTodoCount: 1, todoCount: 1 })],
            today,
        );
        // October 2026 starts on a Thursday: four blanks first.
        expect(cells.slice(0, 4).every((c) => c.title === null)).toBe(true);
        expect(cells[4]).toMatchObject({ day: 1, state: 'written' });
        expect(cells[4 + 23]).toMatchObject({ day: 24, today: true });
        expect(cells[4 + 25]).toMatchObject({ day: 26, state: 'open', future: true });
        expect(cells.length).toBe(4 + 31);
    });
});

describe('yearStrip', () => {
    it('lays the year out a week to a column, with each month labelled', () => {
        const { weeks, months } = yearStrip(2026, [entry('2026-01-01')], new Date(2026, 9, 24));
        expect(weeks.every((w) => w.length === 7)).toBe(true);
        // 1 January 2026 is a Thursday.
        expect(weeks[0][4]).toMatchObject({ title: '2026-01-01', state: 'written' });
        expect(weeks[0][3].title).toBeNull();
        expect(months).toHaveLength(12);
        expect(months[0].week).toBe(0);
        const days = weeks.flat().filter((c) => c.title !== null);
        expect(days).toHaveLength(365);
    });
});
