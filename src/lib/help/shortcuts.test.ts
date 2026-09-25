import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { flattenExtensions, getExtensionField, type AnyExtension } from '@tiptap/core';
import { createContentExtensions } from '$lib/editor/extensions';
import { createCollaborationExtension } from '$lib/editor/yjs';
import { isEditShortcut } from '$lib/editor/editorMode';
import { TOOLS } from '$lib/editor/toolbarTools';
import {
    commandRegistry,
    registerDateCommand,
    registerDocumentLinkCommand,
    registerImageCommand,
    registerTagCommand,
    registerTodoCommand,
} from '$lib/tiptap';
import { INSERT_COMMANDS, SHORTCUT_GROUPS, type ShortcutGroup } from './shortcuts';

// The pickers mount a Svelte component, and inserting an image goes through
// the sync layer. Neither has any part in what the menu is called.
vi.mock('$lib/tiptap/pickerPopup', () => ({
    caretClientRect: vi.fn(),
    closeAnyPicker: vi.fn(),
    openPickerPopup: vi.fn(),
}));
vi.mock('$lib/sync', () => ({
    broadcastAttachmentAvailable: vi.fn(),
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
        const held = new Set(keys.split('-'));
        for (const command of [true, false]) {
            const press = {
                key: keys.split('-').pop()!,
                metaKey: command && held.has('Mod'),
                ctrlKey: !command && held.has('Mod'),
                shiftKey: held.has('Shift'),
                altKey: held.has('Alt'),
            };
            expect(isEditShortcut(press, command)).toBe(true);
        }
    });

    it('name each group once', () => {
        const ids = SHORTCUT_GROUPS.map((g) => g.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the insert menu the help page describes', () => {
    it('is the one the editor registers, entry for entry', () => {
        registerDocumentLinkCommand();
        registerDateCommand();
        registerTodoCommand();
        registerTagCommand();
        registerImageCommand();

        const registered = commandRegistry
            .getAllCommands()
            .map((c) => ({ id: c.id, label: c.label }))
            .sort((a, b) => a.id.localeCompare(b.id));
        const described = INSERT_COMMANDS.map((c) => ({ id: c.id, label: c.label })).sort((a, b) =>
            a.id.localeCompare(b.id),
        );
        expect(described).toEqual(registered);
    });
});
