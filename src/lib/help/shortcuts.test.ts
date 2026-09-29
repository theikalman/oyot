import { describe, expect, it, vi } from 'vitest';
import {
    commandRegistry,
    registerDateCommand,
    registerDocumentLinkCommand,
    registerImageCommand,
    registerTagCommand,
    registerTodoCommand,
} from '$lib/tiptap';
import { INSERT_COMMANDS } from './shortcuts';

// The pickers mount a Svelte component, and inserting an image goes through
// the sync layer. Neither has any part in what the menu is called.
vi.mock('$lib/tiptap/pickerPopup', () => ({
    caretClientRect: vi.fn(),
    closeAnyPicker: vi.fn(),
    openPickerPopup: vi.fn(),
}));
vi.mock('$lib/sync', () => ({
    pullAttachmentFromPeers: vi.fn(),
}));

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
