import {
    canonicalKeys,
    keysFromEvent,
    modIsCommand,
    parseKeys,
    shortcutLabel,
    type KeyPress,
} from './keys';
import { CHANGEABLE_SHORTCUTS, changeableShortcut } from './shortcuts';

// Which keys do what once the user has changed some of them, and what a
// shortcut can be changed to.
//
// What the user changed is kept as overrides: for each shortcut they
// changed, the keys it has instead of its own, or none. Every other shortcut
// keeps its own keys, so one added in a later version arrives with its keys
// rather than with none.
//
// No two shortcuts share a key. A key given to one is taken from whichever
// had it, and that is stored as a change to the other one too, so what each
// shortcut does never depends on the order they are read in.

/** The shortcuts the user changed, by id: the keys each has instead, or none. */
export type Overrides = Readonly<Record<string, readonly string[]>>;

/**
 * Every shortcut the user can change, by id, and the keys that do it now,
 * written the one way (`canonicalKeys`). In the order the list has them.
 */
export type Bindings = ReadonlyMap<string, readonly string[]>;

/** The keys in effect, once `overrides` are applied to the shortcuts' own. */
export function effectiveBindings(
    overrides: Overrides,
    command: boolean = modIsCommand(),
): Bindings {
    const taken = new Set<string>();
    // What the user chose first: a shortcut's own key gives way to one the
    // user has given something else. Only a stored file edited by hand, or a
    // shortcut added since, can have them disagree.
    const chosen = new Map<string, readonly string[]>();
    for (const { id } of CHANGEABLE_SHORTCUTS) {
        if (!Object.prototype.hasOwnProperty.call(overrides, id)) continue;
        const usable = overrides[id].filter((keys) => problemWith(keys, command) === null);
        chosen.set(id, claim(usable, taken, command));
    }
    const bindings = new Map<string, readonly string[]>();
    for (const { id, keys } of CHANGEABLE_SHORTCUTS) {
        bindings.set(id, chosen.get(id) ?? claim(keys, taken, command));
    }
    return bindings;
}

// The keys no shortcut has yet, written the one way, and now taken.
function claim(keys: readonly string[], taken: Set<string>, command: boolean): string[] {
    const mine: string[] = [];
    for (const key of keys) {
        const canonical = canonicalKeys(key, command);
        if (canonical === null || taken.has(canonical)) continue;
        taken.add(canonical);
        mine.push(canonical);
    }
    return mine;
}

function sameKeys(a: readonly string[], b: readonly string[], command: boolean): boolean {
    return (
        a.length === b.length &&
        a.every((keys, i) => canonicalKeys(keys, command) === canonicalKeys(b[i], command))
    );
}

/** Whether shortcut `id` does not have its own keys now. */
export function isChanged(id: string, bindings: Bindings, command = modIsCommand()): boolean {
    const shortcut = changeableShortcut(id);
    return shortcut !== undefined && !sameKeys(bindings.get(id) ?? [], shortcut.keys, command);
}

/** A shortcut that would lose keys to another. */
export interface Conflict {
    /** The shortcut that has them now. */
    id: string;
    /** The keys it would lose. */
    lost: readonly string[];
    /** The keys it would keep, if it has more than one. */
    kept: readonly string[];
}

/** The shortcuts that giving `id` the keys `keys` would take keys from. */
export function conflictsWith(
    id: string,
    keys: readonly string[],
    bindings: Bindings,
    command: boolean = modIsCommand(),
): Conflict[] {
    const wanted = new Set(keys.map((k) => canonicalKeys(k, command)));
    const conflicts: Conflict[] = [];
    for (const [other, held] of bindings) {
        if (other === id) continue;
        const lost = held.filter((k) => wanted.has(k));
        if (lost.length > 0) {
            conflicts.push({ id: other, lost, kept: held.filter((k) => !wanted.has(k)) });
        }
    }
    return conflicts;
}

/**
 * The overrides once shortcut `id` has `keys`: a shortcut, several, or none.
 * Any other shortcut that had one of them keeps the rest of its keys, which
 * may be none. A shortcut given its own keys back is no change, so it is left
 * out, as is the case for every shortcut after resetting them all.
 */
export function assign(
    overrides: Overrides,
    id: string,
    keys: readonly string[],
    command: boolean = modIsCommand(),
): Overrides {
    const bindings = effectiveBindings(overrides, command);
    const next: Record<string, readonly string[]> = { ...overrides };
    for (const conflict of conflictsWith(id, keys, bindings, command)) {
        next[conflict.id] = conflict.kept;
    }
    next[id] = keys.map((k) => canonicalKeys(k, command) ?? k);

    for (const [other, held] of Object.entries(next)) {
        const shortcut = changeableShortcut(other);
        if (shortcut && sameKeys(held, shortcut.keys, command)) delete next[other];
    }
    return next;
}

// Keys a shortcut cannot be changed to, and what they are kept for. The
// clipboard's everywhere. On an Apple device, also the keys its menus give
// the app and the window, and the editor's own Control keys for moving and
// deleting, which every text field on a Mac has.
const KEPT: Record<string, string> = {
    'Mod-a': 'selecting everything',
    'Mod-c': 'copying',
    'Mod-v': 'pasting',
    'Mod-x': 'cutting',
};

const KEPT_ON_APPLE: Record<string, string> = {
    'Mod-h': 'hiding Oyot',
    'Mod-Alt-h': 'hiding the other apps',
    'Mod-m': 'minimizing the window',
    'Mod-q': 'quitting Oyot',
    'Mod-w': 'closing the window',
    'Mod-Ctrl-f': 'switching to full screen',
    'Ctrl-a': 'moving to the start of the paragraph',
    'Ctrl-e': 'moving to the end of the paragraph',
    'Ctrl-d': 'deleting the next character',
    'Ctrl-h': 'deleting the character before',
};

/** What `keys` are kept for, when a shortcut cannot be changed to them. */
export function keptFor(keys: string, command: boolean = modIsCommand()): string | null {
    const canonical = canonicalKeys(keys, command);
    if (canonical === null) return null;
    return KEPT[canonical] ?? (command ? KEPT_ON_APPLE[canonical] : undefined) ?? null;
}

/** How a shortcut is made, for when a press is not one. */
export function howToPress(command: boolean = modIsCommand()): string {
    return command
        ? 'Hold ⌘ or ⌃, and ⌥ or ⇧ if you like, then press a letter, number or symbol.'
        : 'Hold Ctrl, and Alt or Shift if you like, then press a letter, number or symbol.';
}

/**
 * Why `keys` cannot be a shortcut, in words for the user, or null when they
 * can. A shortcut needs Mod, or Control on an Apple device, so it never types
 * anything, and a key that is a character: Enter, Tab and the arrows do
 * different things in different places, and are left to them.
 */
export function problemWith(keys: string, command: boolean = modIsCommand()): string | null {
    const canonical = canonicalKeys(keys, command);
    const chord = canonical === null ? null : parseKeys(canonical);
    if (chord === null) return howToPress(command);
    const held = chord.mod || (command && chord.ctrl);
    const character = [...chord.key].length === 1 && !/\s/u.test(chord.key);
    if (!held || !character) return howToPress(command);
    const kept = keptFor(keys, command);
    if (kept !== null) return `${shortcutLabel(keys, command)} is kept for ${kept}.`;
    return null;
}

/** What a key press is, to someone recording a shortcut. */
export type Press =
    /** Only modifiers so far. */
    | { kind: 'held' }
    /** A shortcut, in the notation. */
    | { kind: 'keys'; keys: string }
    /** Not something a shortcut can be, and why. */
    | { kind: 'refused'; reason: string };

/** Read a key press as a new shortcut. */
export function readPress(event: KeyPress, command: boolean = modIsCommand()): Press {
    const keys = keysFromEvent(event, command);
    if (keys === null) return { kind: 'held' };
    // The Windows or Super key, which the notation has no name for.
    if (!command && event.metaKey) return { kind: 'refused', reason: howToPress(command) };
    const problem = problemWith(keys, command);
    return problem === null ? { kind: 'keys', keys } : { kind: 'refused', reason: problem };
}
