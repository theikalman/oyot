import { describe, expect, it } from 'vitest';
import {
    assign,
    conflictsWith,
    effectiveBindings,
    howToPress,
    isChanged,
    keptFor,
    problemWith,
    readPress,
    type Overrides,
} from './bindings';
import { CHANGEABLE_SHORTCUTS } from './shortcuts';
import type { KeyPress } from './keys';

// On an Apple device, where Mod is Command. Most of what is tested here does
// not depend on the platform.
const MAC = true;
const PC = false;

const keysOf = (overrides: Overrides, id: string, command = MAC) =>
    effectiveBindings(overrides, command).get(id);

function press(
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>>,
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

describe('effectiveBindings', () => {
    it('gives every shortcut its own keys while nothing is changed', () => {
        const bindings = effectiveBindings({}, MAC);

        expect([...bindings.keys()]).toEqual(CHANGEABLE_SHORTCUTS.map((s) => s.id));
        expect(bindings.get('bold')).toEqual(['Mod-b']);
        expect(bindings.get('redo')).toEqual(['Mod-Shift-z', 'Mod-y']);
    });

    it('gives a changed shortcut the keys it was given instead', () => {
        expect(keysOf({ bold: ['Mod-Shift-x'] }, 'bold')).toEqual(['Mod-Shift-x']);
    });

    it('gives a shortcut changed to none no keys', () => {
        expect(keysOf({ bold: [] }, 'bold')).toEqual([]);
    });

    it('writes the keys the one way', () => {
        expect(keysOf({ bold: ['Shift-Mod-X'] }, 'bold')).toEqual(['Mod-Shift-x']);
        expect(keysOf({ bold: ['Ctrl-k'] }, 'bold', PC)).toEqual(['Mod-k']);
    });

    // Only a file edited by hand, or a shortcut added since, can have two
    // shortcuts claim one key.
    it("takes a shortcut's own key from it for one the user gave it to", () => {
        const bindings = effectiveBindings({ italic: ['Mod-b'] }, MAC);

        expect(bindings.get('italic')).toEqual(['Mod-b']);
        expect(bindings.get('bold')).toEqual([]);
    });

    it('gives a key two changed shortcuts claim to the first in the list', () => {
        const bindings = effectiveBindings({ italic: ['Mod-k'], bold: ['Mod-k'] }, MAC);

        expect(bindings.get('bold')).toEqual(['Mod-k']);
        expect(bindings.get('italic')).toEqual([]);
    });

    it('drops keys a shortcut cannot have', () => {
        expect(
            keysOf({ bold: ['Mod-c', 'b', 'Mod-Enter', 'nonsense-x', 'Mod-k'] }, 'bold'),
        ).toEqual(['Mod-k']);
    });

    it('ignores a shortcut it does not know', () => {
        const bindings = effectiveBindings({ someday: ['Mod-k'] }, MAC);

        expect(bindings.has('someday')).toBe(false);
    });
});

describe('isChanged', () => {
    it('is false for a shortcut with its own keys', () => {
        expect(isChanged('bold', effectiveBindings({}, MAC), MAC)).toBe(false);
    });

    it('is true for one with other keys, or none', () => {
        expect(isChanged('bold', effectiveBindings({ bold: ['Mod-k'] }, MAC), MAC)).toBe(true);
        expect(isChanged('bold', effectiveBindings({ bold: [] }, MAC), MAC)).toBe(true);
    });

    it('is true for one that lost a key to another', () => {
        expect(isChanged('bold', effectiveBindings({ italic: ['Mod-b'] }, MAC), MAC)).toBe(true);
    });
});

describe('conflictsWith', () => {
    it('is nothing for keys no other shortcut has', () => {
        expect(conflictsWith('bold', ['Mod-k'], effectiveBindings({}, MAC), MAC)).toEqual([]);
    });

    it('names the shortcut that has the keys, and what it would keep', () => {
        const bindings = effectiveBindings({}, MAC);

        expect(conflictsWith('bold', ['Mod-i'], bindings, MAC)).toEqual([
            { id: 'italic', lost: ['Mod-i'], kept: [] },
        ]);
        expect(conflictsWith('bold', ['Mod-y'], bindings, MAC)).toEqual([
            { id: 'redo', lost: ['Mod-y'], kept: ['Mod-Shift-z'] },
        ]);
    });

    it('does not count the shortcut itself', () => {
        expect(conflictsWith('bold', ['Mod-b'], effectiveBindings({}, MAC), MAC)).toEqual([]);
    });

    it('reads the keys however they are written', () => {
        const [conflict] = conflictsWith('bold', ['Shift-Mod-Z'], effectiveBindings({}, MAC), MAC);

        expect(conflict.id).toBe('redo');
    });
});

describe('assign', () => {
    it('gives a shortcut new keys', () => {
        expect(assign({}, 'bold', ['Mod-k'], MAC)).toEqual({ bold: ['Mod-k'] });
    });

    it('gives a shortcut none', () => {
        expect(assign({}, 'bold', [], MAC)).toEqual({ bold: [] });
    });

    it('takes the keys from the shortcut that had them, which is stored too', () => {
        const next = assign({}, 'bold', ['Mod-i'], MAC);

        expect(next).toEqual({ bold: ['Mod-i'], italic: [] });
        expect(keysOf(next, 'italic')).toEqual([]);
    });

    it('leaves a shortcut the keys it was not asked for', () => {
        expect(assign({}, 'bold', ['Mod-y'], MAC)).toEqual({
            bold: ['Mod-y'],
            redo: ['Mod-Shift-z'],
        });
    });

    it('stores nothing for a shortcut given its own keys back', () => {
        expect(assign({ bold: ['Mod-k'] }, 'bold', ['Mod-b'], MAC)).toEqual({});
    });

    it('takes its own keys back from the shortcut that has them now', () => {
        const swapped = assign({}, 'italic', ['Mod-b'], MAC);

        expect(assign(swapped, 'bold', ['Mod-b'], MAC)).toEqual({ italic: [] });
        expect(assign(assign(swapped, 'bold', ['Mod-b'], MAC), 'italic', ['Mod-i'], MAC)).toEqual(
            {},
        );
    });

    it('keeps what it does not know, for a later version that does', () => {
        expect(assign({ someday: ['Mod-k'] }, 'bold', ['Mod-j'], MAC)).toEqual({
            someday: ['Mod-k'],
            bold: ['Mod-j'],
        });
    });

    it('writes the keys the one way', () => {
        expect(assign({}, 'bold', ['Shift-Mod-K'], MAC)).toEqual({ bold: ['Mod-Shift-k'] });
    });
});

describe('problemWith', () => {
    it('takes Mod, with or without other modifiers, and a letter, digit or symbol', () => {
        expect(problemWith('Mod-k', MAC)).toBeNull();
        expect(problemWith('Mod-Alt-Shift-7', MAC)).toBeNull();
        expect(problemWith('Mod-/', PC)).toBeNull();
        expect(problemWith('Mod-ö', MAC)).toBeNull();
    });

    // Control is a key of its own on a Mac, and never types anything.
    it('takes Control without Command on an Apple device', () => {
        expect(problemWith('Ctrl-k', MAC)).toBeNull();
    });

    // Anything else types, or does something of its own in some places.
    it('wants Mod, or Control on an Apple device', () => {
        expect(problemWith('k', MAC)).toBe(howToPress(MAC));
        expect(problemWith('Shift-k', MAC)).toBe(howToPress(MAC));
        expect(problemWith('Alt-k', PC)).toBe(howToPress(PC));
        expect(problemWith('Alt-Shift-k', MAC)).toBe(howToPress(MAC));
    });

    it('wants a key that is a character', () => {
        expect(problemWith('Mod-Enter', MAC)).toBe(howToPress(MAC));
        expect(problemWith('Mod-ArrowUp', PC)).toBe(howToPress(PC));
        expect(problemWith('Mod-F5', PC)).toBe(howToPress(PC));
        expect(problemWith('Mod- ', MAC)).toBe(howToPress(MAC));
    });

    it('keeps the clipboard keys everywhere', () => {
        expect(problemWith('Mod-c', MAC)).toBe('⌘C is kept for copying.');
        expect(problemWith('Mod-v', PC)).toBe('Ctrl+V is kept for pasting.');
        expect(problemWith('Ctrl-a', PC)).toBe('Ctrl+A is kept for selecting everything.');
    });

    it("keeps an Apple device's app and window keys there, and only there", () => {
        expect(problemWith('Mod-q', MAC)).toBe('⌘Q is kept for quitting Oyot.');
        expect(problemWith('Mod-w', MAC)).toBe('⌘W is kept for closing the window.');
        expect(problemWith('Mod-q', PC)).toBeNull();
    });

    it("keeps the editor's Control keys on an Apple device", () => {
        expect(problemWith('Ctrl-e', MAC)).toBe(
            '⌃E is kept for moving to the end of the paragraph.',
        );
        expect(keptFor('Ctrl-h', MAC)).toBe('deleting the character before');
    });

    it('is not a shortcut at all', () => {
        expect(problemWith('Cmd-k', MAC)).toBe(howToPress(MAC));
    });
});

describe('readPress', () => {
    it('waits while only modifiers are down', () => {
        expect(readPress(press('Meta', { meta: true }, 91), MAC)).toEqual({ kind: 'held' });
    });

    it('reads a shortcut', () => {
        expect(readPress(press('K', { meta: true, shift: true }, 75), MAC)).toEqual({
            kind: 'keys',
            keys: 'Mod-Shift-k',
        });
    });

    it('says why a press cannot be a shortcut', () => {
        expect(readPress(press('k', {}, 75), MAC)).toEqual({
            kind: 'refused',
            reason: howToPress(MAC),
        });
        expect(readPress(press('c', { ctrl: true }, 67), PC)).toEqual({
            kind: 'refused',
            reason: 'Ctrl+C is kept for copying.',
        });
    });

    // The notation has no name for the Windows or Super key.
    it('refuses the Windows key', () => {
        expect(readPress(press('k', { ctrl: true, meta: true }, 75), PC)).toEqual({
            kind: 'refused',
            reason: howToPress(PC),
        });
    });
});
