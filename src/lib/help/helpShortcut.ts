import { matchesKeys, modIsCommand, type KeyPress } from '$lib/keyboard/keys';

// The keyboard shortcut for the help page: Mod-/, from anywhere in the app.
// Mod-/ because the editor leaves it free, and it is where a number of apps
// keep their list of shortcuts. Plain / is the editor's, for the insert menu.

/** The shortcut, in the editor's notation, for the help page to list. */
export const HELP_KEYS = 'Mod-/';

/**
 * Whether a key press is the shortcut that opens the help page. Shift is not
 * ruled out: on some keyboards, a German one for instance, / is typed with
 * Shift held, and the key reported is still /. Where / needs no Shift, Shift
 * turns it into ?, which does not match.
 */
export function isHelpShortcut(event: KeyPress, command: boolean = modIsCommand()): boolean {
    return matchesKeys(HELP_KEYS, event, command);
}
