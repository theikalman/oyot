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
import { TOOLS } from '$lib/editor/toolbarTools';
import { canonicalKeys } from './keys';
import { effectiveBindings, howToPress, keptFor, problemWith } from './bindings';
import { GO_TO_SHORTCUTS } from './goTo';
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

    // A tool's tooltip names the keys of the shortcut with its id, so every
    // tool has one but the two that insert something.
    it("give every toolbar tool a shortcut under its own id, by the tool's name", () => {
        for (const tool of TOOLS) {
            const shortcut = changeableShortcut(tool.id);
            if (tool.id === 'table' || tool.id === 'image') {
                expect(shortcut, tool.id).toBeUndefined();
            } else {
                expect(shortcut?.action, tool.id).toBe(tool.label);
            }
        }
    });

    // The layout answers the ones that go somewhere, the document page Edit,
    // and every page with a sidebar the sidebar's, by these ids.
    it('list the shortcuts the app answers under the ids it answers them by', () => {
        const goingSomewhere = [...group('anywhere').shortcuts, ...group('days').shortcuts];
        expect(goingSomewhere.map((s) => s.id)).toEqual(GO_TO_SHORTCUTS);
        expect(group('document').shortcuts.map((s) => s.id)).toEqual(['edit']);
        expect(group('sidebar').shortcuts.map((s) => s.id)).toEqual(['sidebar']);
    });

    it('name each group once', () => {
        const ids = SHORTCUT_GROUPS.map((g) => g.id);
        expect(new Set(ids).size).toBe(ids.length);
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
