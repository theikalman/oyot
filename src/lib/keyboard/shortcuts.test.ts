import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { flattenExtensions, getExtensionField, type AnyExtension } from '@tiptap/core';
import { createContentExtensions } from '$lib/editor/extensions';
import { createCollaborationExtension } from '$lib/editor/yjs';
import { isEditShortcut } from '$lib/editor/editorMode';
import { isHelpShortcut } from '$lib/help/helpShortcut';
import { TOOLS } from '$lib/editor/toolbarTools';
import { SHORTCUT_GROUPS, type ShortcutGroup } from './shortcuts';

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

// Every key the editor binds, read from the same extensions the live editor
// is built from: its schema, and the collaboration binding that brings undo.
function editorBindings(): Set<string> {
    const extensions = flattenExtensions([
        ...createContentExtensions(),
        createCollaborationExtension(new Y.Doc()),
    ]) as AnyExtension[];
    const keys = new Set<string>();
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
        for (const binding of Object.keys(add?.() ?? {})) keys.add(normalize(binding));
    }
    return keys;
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
});
