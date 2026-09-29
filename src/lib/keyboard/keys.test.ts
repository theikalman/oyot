import { describe, expect, it } from 'vitest';
import { keydownHandler } from '@tiptap/pm/keymap';
import type { EditorView } from '@tiptap/pm/view';
import {
    canonicalKeys,
    keysFromEvent,
    matchesKeys,
    modIsCommand,
    parseKeys,
    shortcutLabel,
    type KeyPress,
} from './keys';

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
        expect(shortcutLabel('Mod--', true)).toBe('⌘-');
        expect(shortcutLabel('Mod--', false)).toBe('Ctrl+-');
    });
});

// A key press as a keyboard sends it. The key code is the one browsers give
// the key on an American layout, which is what the editor falls back to.
function press(
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {},
    keyCode?: number,
): KeyPress {
    return {
        key,
        keyCode,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
    };
}

describe('parseKeys', () => {
    it('takes a shortcut apart', () => {
        expect(parseKeys('Mod-Shift-z')).toEqual({
            key: 'z',
            mod: true,
            ctrl: false,
            alt: false,
            shift: true,
        });
    });

    it('reads the modifiers in any order', () => {
        expect(parseKeys('Shift-Mod-z')).toEqual(parseKeys('Mod-Shift-z'));
    });

    // Shift is its own modifier here, not implied by a capital.
    it('reads a letter in either case', () => {
        expect(parseKeys('Mod-B')).toEqual(parseKeys('Mod-b'));
    });

    it('reads a key that is a hyphen', () => {
        expect(parseKeys('Mod--')?.key).toBe('-');
        expect(parseKeys('-')?.key).toBe('-');
    });

    it('refuses what is not a shortcut', () => {
        expect(parseKeys('')).toBeNull();
        expect(parseKeys('Hyper-x')).toBeNull();
        expect(parseKeys('Mod-Mod-x')).toBeNull();
    });
});

describe('canonicalKeys', () => {
    it('writes the modifiers in one order and a letter in lower case', () => {
        expect(canonicalKeys('Shift-Mod-Z', true)).toBe('Mod-Shift-z');
        expect(canonicalKeys('Shift-Alt-Ctrl-Mod-k', true)).toBe('Mod-Ctrl-Alt-Shift-k');
    });

    // Without a Command key, Control is the key Mod means.
    it('makes Control Mod on a keyboard without Command', () => {
        expect(canonicalKeys('Ctrl-b', false)).toBe('Mod-b');
        expect(canonicalKeys('Ctrl-b', true)).toBe('Ctrl-b');
    });

    it('is null for what is not a shortcut', () => {
        expect(canonicalKeys('Cmd-b', true)).toBeNull();
    });
});

describe('matchesKeys', () => {
    it('takes Mod to be Command on an Apple device and Control elsewhere', () => {
        expect(matchesKeys('Mod-b', press('b', { meta: true }), true)).toBe(true);
        expect(matchesKeys('Mod-b', press('b', { ctrl: true }), true)).toBe(false);
        expect(matchesKeys('Mod-b', press('b', { ctrl: true }), false)).toBe(true);
        expect(matchesKeys('Mod-b', press('b', { meta: true }), false)).toBe(false);
    });

    it('tells Control from Command on an Apple device', () => {
        expect(matchesKeys('Ctrl-b', press('b', { ctrl: true }), true)).toBe(true);
        expect(matchesKeys('Mod-Ctrl-b', press('b', { meta: true, ctrl: true }), true)).toBe(true);
        expect(matchesKeys('Mod-b', press('b', { meta: true, ctrl: true }), true)).toBe(false);
    });

    // Mod-E is the editor's, for inline code, and Mod-Shift-E switches
    // between reading and editing.
    it('wants Shift when the shortcut has it, and only then', () => {
        expect(matchesKeys('Mod-Shift-e', press('e', { meta: true }, 69), true)).toBe(false);
        expect(matchesKeys('Mod-e', press('e', { meta: true }, 69), true)).toBe(true);
    });

    it('wants every modifier the shortcut has, and no other', () => {
        expect(matchesKeys('Mod-Alt-1', press('1', { meta: true, alt: true }, 49), true)).toBe(
            true,
        );
        expect(matchesKeys('Mod-Alt-1', press('1', { meta: true }, 49), true)).toBe(false);
        expect(matchesKeys('Mod-1', press('1', { meta: true, alt: true }, 49), true)).toBe(false);
    });

    // Caps Lock, or a browser reporting the capital with Shift held.
    it('takes a letter in either case', () => {
        expect(matchesKeys('Mod-b', press('B', { meta: true }), true)).toBe(true);
        expect(matchesKeys('Mod-Shift-e', press('E', { meta: true, shift: true }), true)).toBe(
            true,
        );
        expect(matchesKeys('Mod-Shift-e', press('e', { meta: true, shift: true }), true)).toBe(
            true,
        );
    });

    it('never takes Shift held with a letter for the letter alone', () => {
        expect(matchesKeys('Mod-e', press('E', { meta: true, shift: true }, 69), true)).toBe(false);
        expect(matchesKeys('Mod-e', press('e', { meta: true, shift: true }, 69), true)).toBe(false);
    });

    // Shift-8 types *, and the key is still 8.
    it('knows a digit by its key when Shift changes what it types', () => {
        expect(matchesKeys('Mod-Shift-8', press('*', { ctrl: true, shift: true }, 56), false)).toBe(
            true,
        );
        expect(matchesKeys('Mod-8', press('*', { ctrl: true, shift: true }, 56), false)).toBe(
            false,
        );
    });

    // Shift-/ types ? on an American keyboard.
    it('knows a symbol by its key when Shift changes what it types', () => {
        expect(matchesKeys('Mod-Shift-/', press('?', { meta: true, shift: true }, 191), true)).toBe(
            true,
        );
        expect(matchesKeys('Mod-/', press('?', { meta: true, shift: true }, 191), true)).toBe(
            false,
        );
    });

    // A German keyboard types / as Shift-7.
    it('takes a symbol typed with Shift for the symbol', () => {
        expect(matchesKeys('Mod-/', press('/', { meta: true, shift: true }, 55), true)).toBe(true);
    });

    // Option-E starts an accent on a Mac, and the key is still E.
    it('knows a key by its code when Option changes what it types', () => {
        expect(matchesKeys('Mod-Alt-e', press('´', { meta: true, alt: true }, 69), true)).toBe(
            true,
        );
        expect(matchesKeys('Mod-Alt-c', press('ç', { meta: true, alt: true }, 67), true)).toBe(
            true,
        );
    });

    // A Russian keyboard types и on the B key.
    it('knows a letter by its key in another alphabet', () => {
        expect(matchesKeys('Mod-b', press('и', { ctrl: true }, 66), false)).toBe(true);
    });

    // AltGr is Control and Alt together on Windows, and types a character
    // of its own: { on a German keyboard's 7.
    it('leaves AltGr to type its character', () => {
        expect(matchesKeys('Mod-Alt-7', press('{', { ctrl: true, alt: true }, 55), false)).toBe(
            false,
        );
        expect(matchesKeys('Mod-Alt-7', press('7', { ctrl: true, alt: true }, 55), false)).toBe(
            true,
        );
    });

    it('is not another key', () => {
        expect(matchesKeys('Mod-b', press('n', { meta: true }, 78), true)).toBe(false);
        expect(matchesKeys('Mod-b', press('b'), true)).toBe(false);
    });

    it('is nothing for what is not a shortcut', () => {
        expect(matchesKeys('Cmd-b', press('b', { meta: true }), true)).toBe(false);
    });
});

describe('keysFromEvent', () => {
    it('is nothing while only modifiers are down', () => {
        expect(keysFromEvent(press('Meta', { meta: true }, 91), true)).toBeNull();
        expect(keysFromEvent(press('Shift', { meta: true, shift: true }, 16), true)).toBeNull();
        expect(keysFromEvent(press('Control', { ctrl: true }, 17), false)).toBeNull();
    });

    it('writes the press in the notation, Mod for the platform', () => {
        expect(keysFromEvent(press('b', { meta: true }, 66), true)).toBe('Mod-b');
        expect(keysFromEvent(press('b', { ctrl: true }, 66), false)).toBe('Mod-b');
        expect(keysFromEvent(press('b', { ctrl: true }, 66), true)).toBe('Ctrl-b');
        expect(keysFromEvent(press('x', { meta: true, ctrl: true, alt: true }, 88), true)).toBe(
            'Mod-Ctrl-Alt-x',
        );
    });

    it('names a letter or a digit by its key, whatever it types', () => {
        expect(keysFromEvent(press('B', { meta: true, shift: true }, 66), true)).toBe(
            'Mod-Shift-b',
        );
        expect(keysFromEvent(press('*', { ctrl: true, shift: true }, 56), false)).toBe(
            'Mod-Shift-8',
        );
        expect(keysFromEvent(press('∫', { meta: true, alt: true }, 66), true)).toBe('Mod-Alt-b');
        expect(keysFromEvent(press('и', { ctrl: true }, 66), false)).toBe('Mod-b');
    });

    it('names a symbol by what it types, while nothing changes that', () => {
        expect(keysFromEvent(press('/', { meta: true }, 191), true)).toBe('Mod-/');
        expect(keysFromEvent(press('ö', { meta: true }, 192), true)).toBe('Mod-ö');
        expect(keysFromEvent(press('-', { meta: true }, 189), true)).toBe('Mod--');
    });

    it('names a symbol by its key when Shift or Option changes what it types', () => {
        expect(keysFromEvent(press('?', { meta: true, shift: true }, 191), true)).toBe(
            'Mod-Shift-/',
        );
        expect(keysFromEvent(press('÷', { meta: true, alt: true }, 191), true)).toBe('Mod-Alt-/');
    });

    it('names a key that is not a character by its name', () => {
        expect(keysFromEvent(press('Enter', { meta: true }, 13), true)).toBe('Mod-Enter');
        expect(keysFromEvent(press('ArrowUp', {}, 38), true)).toBe('ArrowUp');
    });

    // The notation has no Windows or Super key.
    it('leaves out the Windows key', () => {
        expect(keysFromEvent(press('b', { meta: true, ctrl: true }, 66), false)).toBe('Mod-b');
    });
});

// What is recorded for a press has to be that press again, to the app's own
// shortcuts and to the editor's key bindings alike.
describe('a recorded shortcut', () => {
    const presses: [string, KeyPress, boolean][] = [
        ['Command-B', press('b', { meta: true }, 66), true],
        ['Control-B', press('b', { ctrl: true }, 66), false],
        ['Control-B on a Mac', press('b', { ctrl: true }, 66), true],
        ['Command-Shift-B', press('B', { meta: true, shift: true }, 66), true],
        ['Control-Shift-8', press('*', { ctrl: true, shift: true }, 56), false],
        ['Command-Option-E', press('´', { meta: true, alt: true }, 69), true],
        ['Command-Shift-/', press('?', { meta: true, shift: true }, 191), true],
        ['Control-/', press('/', { ctrl: true }, 191), false],
        ['Command-Ö on a German Mac', press('ö', { meta: true }, 192), true],
        ['Control-B on a Russian keyboard', press('и', { ctrl: true }, 66), false],
        ['Command-hyphen', press('-', { meta: true }, 189), true],
    ];

    it.each(presses)('matches the press it was recorded from: %s', (_, pressed, command) => {
        const keys = keysFromEvent(pressed, command)!;
        expect(matchesKeys(keys, pressed, command)).toBe(true);
    });

    // Mod written as the key it is, so the answer does not depend on the
    // platform the tests run on, which the keymap reads for itself.
    it.each(presses)('is matched by the editor too: %s', (_, pressed, command) => {
        const keys = keysFromEvent(pressed, command)!.replace(/^Mod-/, command ? 'Meta-' : 'Ctrl-');
        const handle = keydownHandler({ [keys]: () => true });
        expect(handle({} as EditorView, pressed as KeyboardEvent)).toBe(true);
    });
});
