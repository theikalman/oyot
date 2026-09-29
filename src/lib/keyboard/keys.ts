// Keyboard shortcuts in the notation the editor writes them in
// (`Mod-Shift-z`), and the keyboard in front of the user: which key Mod is
// on it, and how its keys are labelled.

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

/** The parts of a key press a shortcut is recognised by. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

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
    const parts = keys.split('-');
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
