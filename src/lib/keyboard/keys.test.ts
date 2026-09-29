import { describe, expect, it } from 'vitest';
import { modIsCommand, shortcutLabel } from './keys';

describe('modIsCommand', () => {
    it('takes Mod to be Command on Apple devices', () => {
        expect(modIsCommand('MacIntel')).toBe(true);
        expect(modIsCommand('iPhone')).toBe(true);
        expect(modIsCommand('iPad')).toBe(true);
    });

    it('takes Mod to be Control on everything else', () => {
        expect(modIsCommand('Win32')).toBe(false);
        expect(modIsCommand('Linux x86_64')).toBe(false);
        expect(modIsCommand('Linux armv81')).toBe(false);
    });
});

describe('shortcutLabel', () => {
    it('writes Mod as Command on an Apple device and Control elsewhere', () => {
        expect(shortcutLabel('Mod-b', true)).toBe('⌘B');
        expect(shortcutLabel('Mod-b', false)).toBe('Ctrl+B');
    });

    // Control, Option, Shift, Command: the order every Apple menu uses,
    // whatever order the binding was written in.
    it('orders the modifiers the way Apple menus do', () => {
        expect(shortcutLabel('Mod-Shift-z', true)).toBe('⇧⌘Z');
        expect(shortcutLabel('Shift-Mod-z', true)).toBe('⇧⌘Z');
        expect(shortcutLabel('Mod-Alt-1', true)).toBe('⌥⌘1');
        expect(shortcutLabel('Ctrl-Alt-Shift-Mod-k', true)).toBe('⌃⌥⇧⌘K');
    });

    it('names the modifiers in full elsewhere', () => {
        expect(shortcutLabel('Mod-Shift-z', false)).toBe('Ctrl+Shift+Z');
        expect(shortcutLabel('Mod-Alt-1', false)).toBe('Ctrl+Alt+1');
        expect(shortcutLabel('Mod-Shift-8', false)).toBe('Ctrl+Shift+8');
    });

    it('names a key that is not a character by what is printed on it', () => {
        expect(shortcutLabel('Tab', false)).toBe('Tab');
        expect(shortcutLabel('Shift-Tab', false)).toBe('Shift+Tab');
        expect(shortcutLabel('Shift-Tab', true)).toBe('⇧Tab');
        expect(shortcutLabel('Escape', true)).toBe('Esc');
        expect(shortcutLabel('ArrowUp', false)).toBe('↑');
        expect(shortcutLabel('ArrowDown', true)).toBe('↓');
    });

    // An Apple keyboard's Return and Delete are everyone else's Enter and
    // Backspace.
    it('uses the Apple names for Enter and Backspace on an Apple device', () => {
        expect(shortcutLabel('Shift-Enter', true)).toBe('⇧Return');
        expect(shortcutLabel('Shift-Enter', false)).toBe('Shift+Enter');
        expect(shortcutLabel('Backspace', true)).toBe('Delete');
        expect(shortcutLabel('Backspace', false)).toBe('Backspace');
    });

    it('leaves a key that is a symbol as it is', () => {
        expect(shortcutLabel('/', true)).toBe('/');
    });
});
