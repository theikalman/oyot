import { describe, expect, it } from 'vitest';
import { destination, type Here } from './goTo';

// Thursday 1 October 2026, mid-morning.
const today = new Date(2026, 9, 1, 10, 30);

// On a note, which is no day.
const onANote: Here = { path: '/doc/9b2e2f3a', journal: null };

// On the journal for `title`.
function onJournal(title: string): Here {
    return { path: `/doc/${title}`, journal: title };
}

describe('destination', () => {
    const pages = [
        ['help', '/help'],
        ['search', '/search'],
        ['notes', '/notes'],
        ['journals', '/journals'],
        ['todos', '/todos'],
        ['tags', '/tags'],
        ['settings', '/settings'],
    ] as const;

    it.each(pages)('opens the page %s goes to from anywhere else', (id, path) => {
        expect(destination(id, onANote, today)).toEqual({ kind: 'page', path });
    });

    // Opening it again would only add a step to the history that the back
    // button then takes to no effect.
    it.each(pages)('does nothing on the page %s goes to', (id, path) => {
        expect(destination(id, { path, journal: null }, today)).toBeNull();
    });

    it("goes up to Settings from a page of it, and to the Tags page from a tag's", () => {
        const onSync: Here = { path: '/settings/sync', journal: null };
        const onATag: Here = { path: '/tags/home', journal: null };
        expect(destination('settings', onSync, today)).toEqual({ kind: 'page', path: '/settings' });
        expect(destination('tags', onATag, today)).toEqual({ kind: 'page', path: '/tags' });
    });

    it("opens today's journal from anywhere, and does nothing on it", () => {
        const todays = { kind: 'journal', title: '2026-10-01' };
        expect(destination('today', onANote, today)).toEqual(todays);
        expect(destination('today', { path: '/journals', journal: null }, today)).toEqual(todays);
        expect(destination('today', onJournal('2026-09-14'), today)).toEqual(todays);
        expect(destination('today', onJournal('2026-10-01'), today)).toBeNull();
    });

    it('steps a day either way from the journal on screen', () => {
        const on = onJournal('2026-09-14');
        expect(destination('previousDay', on, today)).toEqual({
            kind: 'journal',
            title: '2026-09-13',
        });
        expect(destination('nextDay', on, today)).toEqual({ kind: 'journal', title: '2026-09-15' });
    });

    it('steps across the end of a month and of a year', () => {
        expect(destination('nextDay', onJournal('2026-09-30'), today)).toEqual({
            kind: 'journal',
            title: '2026-10-01',
        });
        expect(destination('previousDay', onJournal('2027-01-01'), today)).toEqual({
            kind: 'journal',
            title: '2026-12-31',
        });
    });

    // Tomorrow has no journal until it is opened, and opening it starts
    // one, as picking it in the calendar does.
    it('steps past today', () => {
        expect(destination('nextDay', onJournal('2026-10-01'), today)).toEqual({
            kind: 'journal',
            title: '2026-10-02',
        });
    });

    it('steps from today anywhere but a journal', () => {
        for (const here of [onANote, { path: '/settings/sync', journal: null }]) {
            expect(destination('previousDay', here, today)).toEqual({
                kind: 'journal',
                title: '2026-09-30',
            });
            expect(destination('nextDay', here, today)).toEqual({
                kind: 'journal',
                title: '2026-10-02',
            });
        }
    });

    // Only the code that makes journals names them, so this is a journal
    // that went wrong somewhere else. It has no day to step from.
    it('steps from today on a journal whose title is not a date', () => {
        expect(destination('previousDay', onJournal('Groceries'), today)).toEqual({
            kind: 'journal',
            title: '2026-09-30',
        });
    });

    // The editor answers bold, and a name that is no shortcut at all is
    // nothing anyone can press.
    it('goes nowhere for a shortcut that does not go anywhere', () => {
        expect(destination('bold', onANote, today)).toBeNull();
        expect(destination('toString', onANote, today)).toBeNull();
    });
});
