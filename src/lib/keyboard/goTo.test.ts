import { describe, expect, it } from 'vitest';
import { destination } from './goTo';

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
        expect(destination(id, { path: '/doc/1 Oct 2026' })).toEqual({ kind: 'page', path });
    });

    // Opening it again would only add a step to the history that the back
    // button then takes to no effect.
    it.each(pages)('does nothing on the page %s goes to', (id, path) => {
        expect(destination(id, { path })).toBeNull();
    });

    it("goes up to Settings from a page of it, and to the Tags page from a tag's", () => {
        expect(destination('settings', { path: '/settings/shortcuts' })).toEqual({
            kind: 'page',
            path: '/settings',
        });
        expect(destination('tags', { path: '/tags/home' })).toEqual({
            kind: 'page',
            path: '/tags',
        });
    });

    // The editor answers bold, and a name that is no shortcut at all is
    // nothing anyone can press.
    it('goes nowhere for a shortcut that does not go anywhere', () => {
        expect(destination('bold', { path: '/notes' })).toBeNull();
        expect(destination('toString', { path: '/notes' })).toBeNull();
    });
});
