import { describe, expect, it } from 'vitest';
import { isHelpShortcut } from './helpShortcut';

const press = (key: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>>) => ({
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
});

describe('isHelpShortcut', () => {
    it('is Command-/ on an Apple device', () => {
        expect(isHelpShortcut(press('/', { meta: true }), true)).toBe(true);
        expect(isHelpShortcut(press('/', { ctrl: true }), true)).toBe(false);
    });

    it('is Control-/ everywhere else', () => {
        expect(isHelpShortcut(press('/', { ctrl: true }), false)).toBe(true);
        expect(isHelpShortcut(press('/', { meta: true }), false)).toBe(false);
    });

    // Plain / opens the editor's insert menu, and must stay the editor's.
    it('leaves / on its own to the editor', () => {
        expect(isHelpShortcut(press('/', {}), true)).toBe(false);
        expect(isHelpShortcut(press('/', {}), false)).toBe(false);
    });

    // A German keyboard types / as Shift-7.
    it('takes / typed with Shift, on a keyboard that needs it', () => {
        expect(isHelpShortcut(press('/', { meta: true, shift: true }), true)).toBe(true);
    });

    // Where / needs no Shift, holding it types ? instead.
    it('is not ?', () => {
        expect(isHelpShortcut(press('?', { meta: true, shift: true }), true)).toBe(false);
    });

    it('is not some other chord on the same key', () => {
        expect(isHelpShortcut(press('/', { meta: true, alt: true }), true)).toBe(false);
        expect(isHelpShortcut(press('/', { meta: true, ctrl: true }), true)).toBe(false);
    });
});
