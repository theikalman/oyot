import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
    extensions as coreExtensions,
    flattenExtensions,
    getExtensionField,
    type AnyExtension,
} from '@tiptap/core';
import { createContentExtensions } from '$lib/editor/extensions';
import { createCollaborationExtension } from '$lib/editor/yjs';
import { isEditShortcut } from '$lib/editor/editorMode';
import { isHelpShortcut } from '$lib/help/helpShortcut';
import { TOOLS } from '$lib/editor/toolbarTools';
import { canonicalKeys } from './keys';
import { effectiveBindings, howToPress, keptFor, problemWith } from './bindings';
import {
    CHANGEABLE_SHORTCUTS,
    SHORTCUT_GROUPS,
    changeableShortcut,
    type ShortcutGroup,
} from './shortcuts';

// Inserting an image goes through the sync layer, which has no part in what
// a key does.
vi.mock('$lib/sync', () => ({
    pullAttachmentFromPeers: vi.fn(),
}));

// `Shift-Mod-z` and `Mod-Shift-z` are the same binding, and so are `Mod-B`
// and `Mod-b`.
function normalize(keys: string): string {
    const parts = keys.split('-');
    const key = parts.pop()!;
    return [...parts.sort(), key.length === 1 ? key.toLowerCase() : key].join('-');
}

// Every key the editor binds, as written, read from the same extensions the
// live editor is built from: the ones every editor has, for moving and
// deleting, its schema, and the collaboration binding that brings undo. The
// first lot differ on an Apple device, which they tell by the platform.
function editorBindingsAsWritten(platform = 'MacIntel'): string[] {
    vi.stubGlobal('navigator', { platform, userAgent: '' });
    try {
        const extensions = flattenExtensions([
            ...(Object.values(coreExtensions) as AnyExtension[]).filter((e) =>
                ['extension', 'node', 'mark'].includes(e?.type),
            ),
            ...createContentExtensions(),
            createCollaborationExtension(new Y.Doc()),
        ]) as AnyExtension[];
        const keys: string[] = [];
        for (const extension of extensions) {
            const add = getExtensionField<() => Record<string, unknown>>(
                extension,
                'addKeyboardShortcuts',
                {
                    name: extension.name,
                    options: extension.options,
                    storage: extension.storage,
                    editor: undefined as never,
                    type: undefined as never,
                },
            );
            keys.push(...Object.keys(add?.() ?? {}));
        }
        return keys;
    } finally {
        vi.unstubAllGlobals();
    }
}

function editorBindings(): Set<string> {
    return new Set(editorBindingsAsWritten().map(normalize));
}

// A binding in the editor's notation as a key press, the way the keyboard
// in front of the user would send it.
function pressFor(keys: string, command: boolean) {
    const parts = keys.split('-');
    const key = parts.pop()!;
    const held = new Set(parts);
    return {
        key,
        metaKey: command && held.has('Mod'),
        ctrlKey: !command && held.has('Mod'),
        shiftKey: held.has('Shift'),
        altKey: held.has('Alt'),
    };
}

function group(id: string): ShortcutGroup {
    const found = SHORTCUT_GROUPS.find((g) => g.id === id);
    if (!found) throw new Error(`no shortcut group "${id}"`);
    return found;
}

describe('the shortcuts the help page lists', () => {
    // The ones the editor itself answers. The rest are answered by the app's
    // own code: the insert menu, search and dialogs.
    const editorGroups = ['text', 'blocks', 'lists', 'tables', 'history'];

    it.each(editorGroups)('are all bound by the editor: %s', (id) => {
        const bound = editorBindings();
        const unbound = group(id)
            .shortcuts.flatMap((s) => s.keys)
            .filter((keys) => !bound.has(normalize(keys)));
        expect(unbound).toEqual([]);
    });

    it('include every shortcut the toolbar names, under the same name', () => {
        const listed = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts);
        for (const tool of TOOLS) {
            if (!tool.keys) continue;
            const entry = listed.find((s) => s.action === tool.label);
            expect(entry, tool.label).toBeDefined();
            expect(entry!.keys.map(normalize), tool.label).toContain(normalize(tool.keys));
        }
    });

    it('give the Edit button the shortcut it answers to', () => {
        const [keys] = group('document').shortcuts[0].keys;
        for (const command of [true, false]) {
            expect(isEditShortcut(pressFor(keys, command), command)).toBe(true);
        }
    });

    it('give the help page the shortcut it answers to', () => {
        const [keys] = group('anywhere').shortcuts[0].keys;
        for (const command of [true, false]) {
            expect(isHelpShortcut(pressFor(keys, command), command)).toBe(true);
        }
    });

    it('name each group once', () => {
        const ids = SHORTCUT_GROUPS.map((g) => g.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("file each toolbar shortcut under the tool's own id", () => {
        for (const tool of TOOLS) {
            if (!tool.keys) continue;
            const shortcut = changeableShortcut(tool.id);
            expect(shortcut?.action, tool.id).toBe(tool.label);
            expect(shortcut?.keys.map(normalize), tool.id).toContain(normalize(tool.keys));
        }
    });
});

describe('the shortcuts that can be changed', () => {
    const platforms: [string, boolean][] = [
        ['an Apple device', true],
        ['anything else', false],
    ];

    it('have an id each', () => {
        const ids = CHANGEABLE_SHORTCUTS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // So what the settings page lets someone choose is never less than what
    // the app chose for them, and a shortcut reset is one they could have
    // made.
    it.each(platforms)('start with keys they could be changed to, on %s', (_, command) => {
        const refused = CHANGEABLE_SHORTCUTS.flatMap((s) => s.keys).filter(
            (keys) => problemWith(keys, command) !== null,
        );
        expect(refused).toEqual([]);
    });

    it.each(platforms)('start with no key shared, on %s', (_, command) => {
        const bindings = effectiveBindings({}, command);
        for (const shortcut of CHANGEABLE_SHORTCUTS) {
            const own = shortcut.keys.map((keys) => canonicalKeys(keys, command));
            expect(bindings.get(shortcut.id), shortcut.id).toEqual(own);
        }
    });

    // A shortcut given a key the editor already binds would be answered by
    // both, or by whichever came first. So each such key is either the
    // default of one that can be changed, which is then taken from it, or
    // kept.
    it.each([
        ['an Apple device', 'MacIntel', true],
        ['anything else', 'Win32', false],
    ] as const)(
        'leave no key the editor binds to be taken by accident, on %s',
        (_, platform, command) => {
            const defaults = new Set(
                CHANGEABLE_SHORTCUTS.flatMap((s) => s.keys).map((k) => canonicalKeys(k, command)),
            );
            const loose = editorBindingsAsWritten(platform).filter((binding) => {
                // Not something anyone could press as a shortcut.
                if (problemWith(binding, command) === howToPress(command)) return false;
                return !defaults.has(canonicalKeys(binding, command)) && !keptFor(binding, command);
            });
            expect(loose).toEqual([]);
        },
    );
});
