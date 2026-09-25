// Which mode a document opens in: reading, with one exception, a note the
// user has just created. Creating a note is asking to write in it, and
// opening it for reading would show an empty page with nothing to do on it
// but press Edit.
//
// Asked for by whoever creates the note, just before opening it, and used up
// by that open. Not a flag in the URL: the URL says which document is open,
// and going back to it, or reloading it, is an ordinary open that should
// read like any other.

let editOnNextOpen: string | null = null;

/** Open `docId` for editing the next time it is opened, and only then. */
export function openNextForEditing(docId: string): void {
    editOnNextOpen = docId;
}

/**
 * Whether `docId`, being opened now, opens for editing.
 *
 * Asking uses the request up, whichever document it named. It was for the
 * open that followed it, and if that open went somewhere else, a later visit
 * to the new note is an ordinary one.
 */
export function opensForEditing(docId: string): boolean {
    const edit = editOnNextOpen === docId;
    editOnNextOpen = null;
    return edit;
}

// The keyboard shortcut for the Edit button: Mod-Shift-E, from anywhere on a
// document's page, both ways. Not Mod-E, which the editor already gives to
// inline code.

/**
 * Whether "Mod" means Command here, as it does on Apple devices, rather than
 * Control. The test prosemirror-keymap makes, so this shortcut and the
 * editor's own agree about which key is meant.
 */
export function modIsCommand(
    platform: string = typeof navigator !== 'undefined' ? navigator.platform : '',
): boolean {
    return /Mac|iP(hone|[oa]d)/.test(platform);
}

type Keys = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** Whether a key press is the shortcut that switches between reading and editing. */
export function isEditShortcut(event: Keys, command: boolean = modIsCommand()): boolean {
    const mod = command ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    // Either case: with Shift held some browsers report the capital.
    return mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e';
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

/** The Edit button's shortcut the way the keyboard in front of the user labels it. */
export function editShortcutLabel(command: boolean = modIsCommand()): string {
    return shortcutLabel('Mod-Shift-e', command);
}
