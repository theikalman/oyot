import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { flattenExtensions, getExtensionField, type AnyExtension, type Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { assign, effectiveBindings, type Overrides } from '$lib/keyboard/bindings';
import { canonicalKeys, type KeyPress } from '$lib/keyboard/keys';
import { CHANGEABLE_SHORTCUTS } from '$lib/keyboard/shortcuts';
import { createContentExtensions } from './extensions';
import { createCollaborationExtension } from './yjs';
import { EDITOR_COMMANDS, shortcutHandler } from './customShortcuts';

// Inserting an image goes through the sync layer, which has no part in what
// a key does.
vi.mock('$lib/sync', () => ({ pullAttachmentFromPeers: vi.fn() }));

const MAC = true;

// An editor that notes each command run on it, with what it was given.
function recordingEditor() {
    const calls: unknown[][] = [];
    const commands = new Proxy(
        {},
        {
            get:
                (_, name) =>
                (...args: unknown[]) => {
                    calls.push([name, ...args]);
                    return true;
                },
        },
    );
    return { editor: { commands } as unknown as Editor, calls };
}

function press(
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>>,
    keyCode: number,
): KeyboardEvent {
    const event: KeyPress = {
        key,
        keyCode,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
    };
    return event as KeyboardEvent;
}

const view = {} as EditorView;

// The shortcuts with `overrides`, as the editor answers them on a Mac, and
// the commands they ran.
function handlerWith(overrides: Overrides) {
    const { editor, calls } = recordingEditor();
    const handle = shortcutHandler(effectiveBindings(overrides, MAC), MAC, editor);
    return { handle: (event: KeyboardEvent) => handle(view, event), calls };
}

describe('EDITOR_COMMANDS', () => {
    // Help and Edit are answered from the window.
    it('covers every shortcut that can be changed but the app’s own', () => {
        const answered = CHANGEABLE_SHORTCUTS.map((s) => s.id).filter(
            (id) => id !== 'help' && id !== 'edit',
        );
        expect(Object.keys(EDITOR_COMMANDS).sort()).toEqual(answered.sort());
    });

    // Every key binding of the editor's, run on an editor that notes what
    // it was asked to do: the extensions call `this.editor`.
    function bindingsRunOn(editor: Editor): Map<string, () => unknown> {
        const extensions = flattenExtensions([
            ...createContentExtensions(),
            createCollaborationExtension(new Y.Doc()),
        ]) as AnyExtension[];
        const bindings = new Map<string, () => unknown>();
        for (const extension of extensions) {
            const add = getExtensionField<
                () => Record<string, (props: { editor: Editor }) => unknown>
            >(extension, 'addKeyboardShortcuts', {
                name: extension.name,
                options: extension.options,
                storage: extension.storage,
                editor,
                type: undefined as never,
            });
            for (const [keys, run] of Object.entries(add?.() ?? {})) {
                const canonical = canonicalKeys(keys, MAC);
                if (canonical && !bindings.has(canonical)) {
                    bindings.set(canonical, () => run({ editor }));
                }
            }
        }
        return bindings;
    }

    it.each(Object.keys(EDITOR_COMMANDS))('runs what the editor’s own keys run: %s', (id) => {
        const shortcut = CHANGEABLE_SHORTCUTS.find((s) => s.id === id)!;
        const own = recordingEditor();
        const ours = recordingEditor();

        bindingsRunOn(own.editor).get(canonicalKeys(shortcut.keys[0], MAC)!)!();
        EDITOR_COMMANDS[id](ours.editor);

        expect(ours.calls).toEqual(own.calls);
        expect(ours.calls).toHaveLength(1);
    });
});

describe('shortcutHandler', () => {
    // So a device where nothing is changed has the editor exactly as it was.
    it('answers nothing while nothing is changed', () => {
        const { handle, calls } = handlerWith({});

        expect(handle(press('b', { meta: true }, 66))).toBe(false);
        expect(handle(press('z', { meta: true }, 90))).toBe(false);
        expect(calls).toEqual([]);
    });

    it('runs a shortcut on its new keys', () => {
        const { handle, calls } = handlerWith({ bold: ['Mod-k'] });

        expect(handle(press('k', { meta: true }, 75))).toBe(true);
        expect(calls).toEqual([['toggleBold']]);
    });

    it('does nothing on keys a shortcut no longer has', () => {
        const { handle, calls } = handlerWith({ bold: ['Mod-k'] });

        expect(handle(press('b', { meta: true }, 66))).toBe(true);
        expect(handle(press('B', { meta: true }, 66))).toBe(true);
        expect(calls).toEqual([]);
    });

    it('does nothing on the keys of a shortcut given none', () => {
        const { handle, calls } = handlerWith({ bold: [] });

        expect(handle(press('b', { meta: true }, 66))).toBe(true);
        expect(calls).toEqual([]);
    });

    it('leaves keys nobody changed to the editor', () => {
        const { handle, calls } = handlerWith({ bold: ['Mod-k'] });

        expect(handle(press('i', { meta: true }, 73))).toBe(false);
        expect(handle(press('B', { meta: true, shift: true }, 66))).toBe(false);
        expect(calls).toEqual([]);
    });

    it('swaps two shortcuts', () => {
        const swapped = assign(assign({}, 'bold', ['Mod-i'], MAC), 'italic', ['Mod-b'], MAC);
        const { handle, calls } = handlerWith(swapped);

        handle(press('i', { meta: true }, 73));
        handle(press('b', { meta: true }, 66));

        expect(calls).toEqual([['toggleBold'], ['toggleItalic']]);
    });

    it('keeps the keys a shortcut had left after losing one', () => {
        const { handle, calls } = handlerWith(assign({}, 'bold', ['Mod-y'], MAC));

        handle(press('y', { meta: true }, 89));
        handle(press('Z', { meta: true, shift: true }, 90));

        expect(calls).toEqual([['toggleBold'], ['redo']]);
    });

    it('runs the command it was given with what it takes', () => {
        const { handle, calls } = handlerWith({ heading2: ['Mod-Alt-j'] });

        handle(press('∆', { meta: true, alt: true }, 74));

        expect(calls).toEqual([['toggleHeading', { level: 2 }]]);
    });

    // Help's new keys pass on to the window, which answers them. Nothing of
    // the editor's may answer them first: underline binds Mod-U, which is
    // what Command-Shift-U looks like to its keymap.
    it('takes the keys of a shortcut the app answers, and runs nothing', () => {
        const { handle, calls } = handlerWith(assign({}, 'help', ['Mod-Shift-u'], MAC));

        expect(handle(press('U', { meta: true, shift: true }, 85))).toBe(true);
        expect(calls).toEqual([]);
    });

    it('frees the keys of a shortcut the app answers for the editor', () => {
        const { handle, calls } = handlerWith({ edit: ['Mod-Alt-e'], code: ['Mod-Shift-e'] });

        expect(handle(press('E', { meta: true, shift: true }, 69))).toBe(true);
        expect(calls).toEqual([['toggleCode']]);
    });
});
