import { Extension, type Editor } from '@tiptap/core';
import { keydownHandler } from '@tiptap/pm/keymap';
import { Plugin, PluginKey, type Command } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { effectiveBindings, isChanged, type Bindings } from '$lib/keyboard/bindings';
import { canonicalKeys, matchesKeys, modIsCommand } from '$lib/keyboard/keys';
import { CHANGEABLE_SHORTCUTS } from '$lib/keyboard/shortcuts';

/**
 * What each shortcut the editor answers does: the command its own key
 * binding runs, so a shortcut given other keys does exactly what the old
 * keys did. The rest, Help and Edit, are the app's, answered from the
 * window.
 */
export const EDITOR_COMMANDS: Readonly<Record<string, (editor: Editor) => boolean>> = {
    bold: (editor) => editor.commands.toggleBold(),
    italic: (editor) => editor.commands.toggleItalic(),
    underline: (editor) => editor.commands.toggleUnderline(),
    strike: (editor) => editor.commands.toggleStrike(),
    code: (editor) => editor.commands.toggleCode(),
    heading1: (editor) => editor.commands.toggleHeading({ level: 1 }),
    heading2: (editor) => editor.commands.toggleHeading({ level: 2 }),
    heading3: (editor) => editor.commands.toggleHeading({ level: 3 }),
    heading4: (editor) => editor.commands.toggleHeading({ level: 4 }),
    heading5: (editor) => editor.commands.toggleHeading({ level: 5 }),
    heading6: (editor) => editor.commands.toggleHeading({ level: 6 }),
    paragraph: (editor) => editor.commands.setParagraph(),
    bulletList: (editor) => editor.commands.toggleBulletList(),
    orderedList: (editor) => editor.commands.toggleOrderedList(),
    taskList: (editor) => editor.commands.toggleTaskList(),
    blockquote: (editor) => editor.commands.toggleBlockquote(),
    codeBlock: (editor) => editor.commands.toggleCodeBlock(),
    undo: (editor) => editor.commands.undo(),
    redo: (editor) => editor.commands.redo(),
};

/**
 * How the editor answers the shortcuts the user changed, ahead of its own
 * key bindings, which cannot be told about them: every extension carries
 * its keys with it.
 *
 * A changed shortcut's keys do its command, or, for one the app answers,
 * nothing here: the key press goes on to the window, and no binding of the
 * editor's gets it on the way. A shortcut's own keys, once it no longer has
 * them, do nothing, rather than what they used to. Keys nobody changed are
 * left to the editor, so while nothing is changed this answers nothing.
 */
export function shortcutHandler(
    bindings: Bindings,
    command: boolean,
    editor: Editor,
): (view: EditorView, event: KeyboardEvent) => boolean {
    const changed = CHANGEABLE_SHORTCUTS.filter((s) => isChanged(s.id, bindings, command));
    if (changed.length === 0) return () => false;

    const mine = changed.map((s) => ({ id: s.id, keys: bindings.get(s.id) ?? [] }));
    // Matched by the editor's own rules, so they catch what its binding
    // would have: a capital, or a key typed differently with Shift held.
    const swallowed: Record<string, Command> = {};
    for (const shortcut of changed) {
        if (!EDITOR_COMMANDS[shortcut.id]) continue;
        for (const keys of shortcut.keys) {
            const canonical = canonicalKeys(keys, command);
            if (canonical) swallowed[asTheEditorWritesIt(canonical, command)] = () => true;
        }
    }
    const swallow = keydownHandler(swallowed);

    return (view, event) => {
        for (const { id, keys } of mine) {
            if (!keys.some((k) => matchesKeys(k, event, command))) continue;
            // Taken whether or not the command can run here, so the press
            // never falls through to a binding of the editor's that shares
            // the key's name, the way Mod-B does for bold.
            EDITOR_COMMANDS[id]?.(editor);
            return true;
        }
        return swallow(view, event);
    };
}

// Mod as the key it is here, the notation's first modifier. The editor's
// keymap works that out for itself in the same way, but spelled out, the
// answer does not depend on where the tests run.
function asTheEditorWritesIt(keys: string, command: boolean): string {
    return keys.replace(/^Mod-/, command ? 'Meta-' : 'Ctrl-');
}

export interface CustomShortcutsOptions {
    /** The shortcuts in effect now, asked on every key press so a change applies at once. */
    bindings: () => Bindings;
    /** Whether Mod is Command. */
    command: boolean;
}

/**
 * The user's own keyboard shortcuts in the editor (ADR 0035).
 *
 * First of every extension, so it sees a key press before any of their
 * bindings, the collaboration binding's undo and redo included, which are
 * at priority 1000.
 */
export const CustomShortcuts = Extension.create<CustomShortcutsOptions>({
    name: 'customShortcuts',
    priority: 10_000,

    addOptions() {
        const command = modIsCommand();
        const unchanged = effectiveBindings({}, command);
        return { bindings: () => unchanged, command };
    },

    addProseMirrorPlugins() {
        const { editor } = this;
        const { bindings, command } = this.options;
        // Built again only when the shortcuts change, which replaces them.
        let built: {
            from: Bindings;
            handle: (view: EditorView, event: KeyboardEvent) => boolean;
        } | null = null;
        return [
            new Plugin({
                key: new PluginKey('customShortcuts'),
                props: {
                    handleKeyDown: (view, event) => {
                        const current = bindings();
                        if (built?.from !== current) {
                            built = {
                                from: current,
                                handle: shortcutHandler(current, command, editor),
                            };
                        }
                        return built.handle(view, event);
                    },
                },
            }),
        ];
    },
});
