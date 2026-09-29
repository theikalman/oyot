// Keyboard shortcuts in the notation the editor writes them in
// (`Mod-Shift-z`), and the keyboard in front of the user: which key Mod is
// on it, which press a shortcut is, and how its keys are labelled.

/**
 * Whether "Mod" means Command here, as it does on Apple devices, rather than
 * Control. The test prosemirror-keymap makes, so the app's own shortcuts and
 * the editor's agree about which key is meant.
 */
export function modIsCommand(
    platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): boolean {
    return /Mac|iP(hone|[oa]d)/.test(platform);
}

/**
 * The parts of a key press a shortcut is recognised by. The key code is
 * optional because only a modifier that changes what a key types needs it.
 */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> &
    Partial<Pick<KeyboardEvent, 'keyCode'>>;

/** A shortcut taken apart: its key, and the modifiers held with it. */
export interface Chord {
    /** A letter in lower case, a digit or a symbol, or a key's name (`Enter`). */
    key: string;
    /** Command on an Apple device, Control everywhere else. */
    mod: boolean;
    /** Control on an Apple device, where it is a key of its own. Elsewhere it is Mod. */
    ctrl: boolean;
    /** Option on an Apple device. */
    alt: boolean;
    shift: boolean;
}

/**
 * A shortcut in the editor's notation taken apart, or null when it is not
 * one. The modifiers may come in any order, as they may for the editor. The
 * key comes last, and a key that is itself a hyphen is written `Mod--`.
 *
 * A letter is read in either case: Shift is a modifier of its own here, so
 * `Mod-B` is `Mod-b`, not the editor's shorthand for `Mod-Shift-b`.
 */
export function parseKeys(keys: string): Chord | null {
    const parts = keys.split(/-(?!$)/);
    const key = parts.pop();
    if (!key) return null;
    const chord: Chord = {
        key: key.length === 1 ? key.toLowerCase() : key,
        mod: false,
        ctrl: false,
        alt: false,
        shift: false,
    };
    for (const part of parts) {
        const name = MODIFIER_NAMES[part];
        if (!name || chord[name]) return null;
        chord[name] = true;
    }
    return chord;
}

const MODIFIER_NAMES: Record<string, 'mod' | 'ctrl' | 'alt' | 'shift'> = {
    Mod: 'mod',
    Ctrl: 'ctrl',
    Alt: 'alt',
    Shift: 'shift',
};

/** A chord in the notation, its modifiers always in one order: Mod, Ctrl, Alt, Shift. */
export function formatKeys(chord: Chord): string {
    const held = [
        chord.mod && 'Mod',
        chord.ctrl && 'Ctrl',
        chord.alt && 'Alt',
        chord.shift && 'Shift',
    ].filter(Boolean);
    return [...held, chord.key].join('-');
}

/**
 * A shortcut written the one way, so two spellings of it compare equal:
 * `Shift-Mod-Z` is `Mod-Shift-z`. On a keyboard without a Command key,
 * Control is Mod, so `Ctrl-b` is `Mod-b` there. Null when it is not a
 * shortcut at all.
 */
export function canonicalKeys(keys: string, command: boolean = modIsCommand()): string | null {
    const chord = parseKeys(keys);
    if (!chord) return null;
    if (!command && chord.ctrl) {
        chord.mod = true;
        chord.ctrl = false;
    }
    return formatKeys(chord);
}

// What the editor's keymap calls a key by its code (w3c-keyname's table),
// for the keys a shortcut can use. It falls back to that name when a
// modifier makes the key type something else: Option on a Mac turns E into
// ´, Shift turns 8 into *, and a Russian keyboard types и on the B key.
const CODE_NAMES: Record<number, string> = {
    59: ';',
    61: '=',
    106: '*',
    107: '+',
    108: ',',
    109: '-',
    110: '.',
    111: '/',
    173: '-',
    186: ';',
    187: '=',
    188: ',',
    189: '-',
    190: '.',
    191: '/',
    192: '`',
    219: '[',
    220: '\\',
    221: ']',
    222: "'",
};

function keyFromCode(keyCode: number | undefined): string | undefined {
    if (keyCode === undefined) return undefined;
    if (keyCode >= 65 && keyCode <= 90) return String.fromCharCode(keyCode + 32);
    if (keyCode >= 48 && keyCode <= 57) return String(keyCode - 48);
    if (keyCode >= 96 && keyCode <= 105) return String(keyCode - 96);
    return CODE_NAMES[keyCode];
}

/** Whether a key is a letter, which Shift makes a capital of. */
function isLetter(key: string): boolean {
    return key.length === 1 && key.toLowerCase() !== key.toUpperCase();
}

/**
 * Whether a key press is the shortcut `keys`, read the way the editor reads
 * its own: the modifiers exactly, and the key by what it types, or by which
 * key it is when a modifier changes what it types.
 */
export function matchesKeys(
    keys: string,
    event: KeyPress,
    command: boolean = modIsCommand(),
): boolean {
    const want = parseKeys(keys);
    if (!want) return false;
    const meta = command && want.mod;
    const ctrl = command ? want.ctrl : want.mod || want.ctrl;
    if (event.metaKey !== meta || event.ctrlKey !== ctrl || event.altKey !== want.alt) {
        return false;
    }

    // Either case: with Shift held some browsers report the capital and
    // some do not.
    const typed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (typed === want.key && event.shiftKey === want.shift) return true;

    // A symbol some keyboards type with Shift held, named by what it types:
    // a German keyboard types / as Shift-7, and the key reported is still /.
    // Never a letter, where Shift held is a different shortcut.
    if (event.shiftKey && !want.shift && event.key === want.key && !isLetter(want.key)) {
        return true;
    }

    // Which key it is, when a modifier changed what it typed. Not with
    // Control and Alt held off an Apple device, where together they can be
    // AltGr, and what they type is a character in its own right.
    const altGr = !command && event.ctrlKey && event.altKey;
    return !altGr && event.shiftKey === want.shift && keyFromCode(event.keyCode) === want.key;
}

// Keys that are only ever held with another.
const MODIFIER_KEYS = new Set([
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'FnLock',
    'Hyper',
    'Meta',
    'NumLock',
    'OS',
    'ScrollLock',
    'Shift',
    'Super',
    'Symbol',
    'SymbolLock',
]);

/**
 * A key press as a shortcut in the notation, for recording one: the
 * modifiers held and the key pressed. Null while only modifiers are down.
 *
 * A letter or a digit is named by which key it is, so Shift, Option or the
 * alphabet in use do not change the name: Command-Shift-8 is `Mod-Shift-8`
 * and not `Mod-Shift-*`, as it is for the editor. A symbol is named by what
 * it types while nothing changes that, which on a German keyboard is `ö`
 * rather than the name the key has on an American one. The Windows or Super
 * key is not a modifier the notation has, and is left out.
 */
export function keysFromEvent(event: KeyPress, command: boolean = modIsCommand()): string | null {
    if (MODIFIER_KEYS.has(event.key)) return null;
    return formatKeys({
        key: pressedKey(event),
        mod: command ? event.metaKey : event.ctrlKey,
        ctrl: command && event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
    });
}

function pressedKey(event: KeyPress): string {
    const code = keyFromCode(event.keyCode);
    if (code && /^[a-z0-9]$/.test(code)) return code;
    const typed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (typed.length === 1 && !event.shiftKey && !event.altKey) return typed;
    return code ?? typed;
}

// How an Apple menu writes each modifier, in the order it writes them.
const APPLE_MODIFIERS: [name: string, symbol: string][] = [
    ['Ctrl', '⌃'],
    ['Alt', '⌥'],
    ['Shift', '⇧'],
    ['Mod', '⌘'],
];

/**
 * A key that is not a character, by the name printed on it. An Apple
 * keyboard names two of them differently: its Enter says Return, and its
 * Backspace says Delete.
 */
function keyName(key: string, command: boolean): string {
    switch (key) {
        case 'Enter':
            return command ? 'Return' : 'Enter';
        case 'Backspace':
            return command ? 'Delete' : 'Backspace';
        case 'Escape':
            return 'Esc';
        case 'ArrowUp':
            return '↑';
        case 'ArrowDown':
            return '↓';
        default:
            // A letter is printed on its key as a capital.
            return key.length === 1 ? key.toUpperCase() : key;
    }
}

/**
 * A key binding in the editor's notation (`Mod-Shift-z`), the way the
 * keyboard in front of the user labels it: `⇧⌘Z` on an Apple device, in the
 * order its own menus use, and `Ctrl+Shift+Z` everywhere else.
 */
export function shortcutLabel(keys: string, command: boolean = modIsCommand()): string {
    const parts = keys.split(/-(?!$)/);
    const key = keyName(parts.pop()!, command);
    const held = new Set(parts);
    if (command) {
        const symbols = APPLE_MODIFIERS.filter(([name]) => held.has(name)).map(([, s]) => s);
        return symbols.join('') + key;
    }
    const names: string[] = [];
    if (held.has('Mod') || held.has('Ctrl')) names.push('Ctrl');
    if (held.has('Alt')) names.push('Alt');
    if (held.has('Shift')) names.push('Shift');
    return [...names, key].join('+');
}
