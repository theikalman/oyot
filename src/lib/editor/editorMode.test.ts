import { beforeEach, describe, expect, it } from 'vitest';
import {
    editShortcutLabel,
    isEditShortcut,
    modIsCommand,
    openNextForEditing,
    opensForEditing,
    shortcutLabel,
} from './editorMode';

describe('opensForEditing', () => {
    // The request is module state; asking about anything clears it.
    beforeEach(() => {
        opensForEditing('');
    });

    it('opens a document for reading', () => {
        expect(opensForEditing('a')).toBe(false);
    });

    it('opens a note just created for editing', () => {
        openNextForEditing('a');

        expect(opensForEditing('a')).toBe(true);
    });

    // Going back to it later, or reloading it, is an ordinary open.
    it('opens it for reading after that', () => {
        openNextForEditing('a');
        opensForEditing('a');

        expect(opensForEditing('a')).toBe(false);
    });

    it('does not open some other document for editing', () => {
        openNextForEditing('a');

        expect(opensForEditing('b')).toBe(false);
    });

    // The navigation to the new note went elsewhere, and the note is reached
    // later by some ordinary way in.
    it('forgets the request once another document has been opened', () => {
        openNextForEditing('a');
        opensForEditing('b');

        expect(opensForEditing('a')).toBe(false);
    });

    it('keeps only the latest request', () => {
        openNextForEditing('a');
        openNextForEditing('b');

        expect(opensForEditing('b')).toBe(true);
    });
});

describe('isEditShortcut', () => {
    const press = (
        key: string,
        mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>>,
    ) => ({
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
    });

    it('is Command-Shift-E on an Apple device', () => {
        expect(isEditShortcut(press('E', { meta: true, shift: true }), true)).toBe(true);
        expect(isEditShortcut(press('E', { ctrl: true, shift: true }), true)).toBe(false);
    });

    it('is Control-Shift-E everywhere else', () => {
        expect(isEditShortcut(press('E', { ctrl: true, shift: true }), false)).toBe(true);
        expect(isEditShortcut(press('E', { meta: true, shift: true }), false)).toBe(false);
    });

    // Some browsers report the letter in lower case with Command held.
    it('takes the letter in either case', () => {
        expect(isEditShortcut(press('e', { meta: true, shift: true }), true)).toBe(true);
    });

    // Mod-E is the editor's own, for inline code.
    it('leaves Mod-E to the editor', () => {
        expect(isEditShortcut(press('e', { meta: true }), true)).toBe(false);
        expect(isEditShortcut(press('e', { ctrl: true }), false)).toBe(false);
    });

    it('is not some other chord on the same key', () => {
        expect(isEditShortcut(press('E', { meta: true, shift: true, alt: true }), true)).toBe(
            false,
        );
        expect(isEditShortcut(press('E', { meta: true, ctrl: true, shift: true }), true)).toBe(
            false,
        );
        expect(isEditShortcut(press('E', { shift: true }), true)).toBe(false);
    });

    it('is not another key', () => {
        expect(isEditShortcut(press('R', { meta: true, shift: true }), true)).toBe(false);
    });
});

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

describe('editShortcutLabel', () => {
    it('spells the shortcut the way the keyboard does', () => {
        expect(editShortcutLabel(true)).toBe('⇧⌘E');
        expect(editShortcutLabel(false)).toBe('Ctrl+Shift+E');
    });
});
