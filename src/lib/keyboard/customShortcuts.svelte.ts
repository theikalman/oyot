import { invoke } from '@tauri-apps/api/core';
import { assign, effectiveBindings, isChanged, type Bindings, type Overrides } from './bindings';
import { matchesKeys, modIsCommand, shortcutLabel, type KeyPress } from './keys';
import { CHANGEABLE_SHORTCUTS, changeableShortcut } from './shortcuts';

/**
 * The keyboard shortcuts in effect on this device, the user's changes
 * included (ADR 0035).
 *
 * Module state, because a key is answered and named all over the app: the
 * layout answers the ones that go somewhere, the document page Edit, and
 * the editor the rest, while tooltips and the help page name them. Loaded at startup, and until
 * then, or if loading fails, every shortcut has its own keys.
 *
 * The rules are in bindings.ts, where they can be tested; this only holds
 * what the user changed, and stores it.
 */
function createCustomShortcuts() {
    const command = modIsCommand();
    let overrides = $state.raw<Overrides>({});
    // Changes made so far. A load that finishes after one has been made is
    // older than it, and is dropped.
    let revision = 0;

    // Worked out again only when the overrides are replaced, which is the
    // only way they change. Read through `overrides`, so whatever reads the
    // bindings in a template or an effect follows a change.
    let cache: { from: Overrides; bindings: Bindings } | null = null;
    function bindings(): Bindings {
        const from = overrides;
        if (cache?.from !== from) cache = { from, bindings: effectiveBindings(from, command) };
        return cache.bindings;
    }

    function keysFor(id: string): readonly string[] {
        return bindings().get(id) ?? [];
    }

    // Shown at once, and put back if it cannot be stored, so what the page
    // shows is always what the keys do.
    async function save(next: Overrides): Promise<void> {
        const previous = overrides;
        revision++;
        overrides = next;
        try {
            await invoke('save_keyboard_shortcuts', { shortcuts: next });
        } catch (error) {
            if (overrides === next) overrides = previous;
            throw error;
        }
    }

    return {
        /** Whether Mod is Command on this device. */
        command,

        /** Every shortcut that can be changed, and the keys that do it now. */
        get bindings(): Bindings {
            return bindings();
        },

        /** The keys that do shortcut `id` now, possibly none. */
        keysFor,

        /** The first of them, the way this keyboard labels it, or null for none. */
        labelFor(id: string): string | null {
            const [first] = keysFor(id);
            return first === undefined ? null : shortcutLabel(first, command);
        },

        /** Whether shortcut `id` has other keys than its own now. */
        isChanged(id: string): boolean {
            return isChanged(id, bindings(), command);
        },

        /** How many shortcuts have other keys than their own. */
        get changedCount(): number {
            return CHANGEABLE_SHORTCUTS.filter((s) => isChanged(s.id, bindings(), command)).length;
        },

        /** Whether a key press is shortcut `id`. */
        matches(id: string, event: KeyPress): boolean {
            return keysFor(id).some((keys) => matchesKeys(keys, event, command));
        },

        async load(): Promise<void> {
            const before = revision;
            try {
                const stored = await invoke<Record<string, string[]> | null>(
                    'get_keyboard_shortcuts',
                );
                if (revision === before) overrides = stored ?? {};
            } catch (error) {
                console.warn('[shortcuts] could not load the keyboard shortcuts:', error);
            }
        },

        /**
         * Give shortcut `id` the keys `keys`, or none, taking them from
         * whichever shortcut had them. Rejects if they cannot be stored,
         * and then nothing has changed.
         */
        set(id: string, keys: readonly string[]): Promise<void> {
            return save(assign(overrides, id, keys, command));
        },

        /** Give shortcut `id` its own keys back, taking them from whichever has them now. */
        reset(id: string): Promise<void> {
            const shortcut = changeableShortcut(id);
            if (!shortcut) return Promise.resolve();
            return save(assign(overrides, id, shortcut.keys, command));
        },

        /** Give every shortcut its own keys back. */
        resetAll(): Promise<void> {
            return save({});
        },
    };
}

export const customShortcuts = createCustomShortcuts();
