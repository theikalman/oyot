import { HELP_KEYS } from '$lib/help/helpShortcut';

// Every keyboard shortcut Oyot has: the keys, what they do, and where. The
// help page lists them all.
//
// Written out here rather than read off the editor, because most of these
// reach the app by way of a library and have to be put in words a person
// uses. shortcuts.test.ts holds the list to the editor's real key bindings
// and the toolbar's, so the page cannot promise a key that does nothing or
// leave out one the toolbar names.

/** One thing a key does. */
export interface Shortcut {
    /** What pressing it does. */
    action: string;
    /**
     * The keys, in the editor's notation (`Mod-Shift-z`), which
     * `shortcutLabel` writes the way the keyboard in front of the user
     * labels them. More than one when any of them will do.
     */
    keys: readonly string[];
}

export interface ShortcutGroup {
    /** Unique. The tests find a group by it. */
    id: string;
    title: string;
    /** Where the keys work. */
    where: string;
    shortcuts: readonly Shortcut[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    {
        id: 'anywhere',
        title: 'Anywhere',
        where: 'Wherever you are in Oyot, unless a dialog is open',
        shortcuts: [{ action: 'Open this help page', keys: [HELP_KEYS] }],
    },
    {
        id: 'document',
        title: 'Notes and journals',
        where: 'On any open note or journal',
        shortcuts: [{ action: 'Switch between reading and editing', keys: ['Mod-Shift-e'] }],
    },
    {
        id: 'text',
        title: 'Text',
        where: 'While editing, on the selected text or on what you type next',
        shortcuts: [
            { action: 'Bold', keys: ['Mod-b'] },
            { action: 'Italic', keys: ['Mod-i'] },
            { action: 'Underline', keys: ['Mod-u'] },
            { action: 'Strikethrough', keys: ['Mod-Shift-s'] },
            { action: 'Inline code', keys: ['Mod-e'] },
        ],
    },
    {
        id: 'blocks',
        title: 'Headings and blocks',
        where: 'While editing, on the paragraph the cursor is in',
        shortcuts: [
            { action: 'Heading 1', keys: ['Mod-Alt-1'] },
            { action: 'Heading 2', keys: ['Mod-Alt-2'] },
            { action: 'Heading 3', keys: ['Mod-Alt-3'] },
            { action: 'Heading 4, 5 or 6', keys: ['Mod-Alt-4', 'Mod-Alt-5', 'Mod-Alt-6'] },
            { action: 'Normal text', keys: ['Mod-Alt-0'] },
            { action: 'Bulleted list', keys: ['Mod-Shift-8'] },
            { action: 'Numbered list', keys: ['Mod-Shift-7'] },
            { action: 'Task list', keys: ['Mod-Shift-9'] },
            { action: 'Quote', keys: ['Mod-Shift-b'] },
            { action: 'Code block', keys: ['Mod-Alt-c'] },
            { action: 'Leave a code block', keys: ['Mod-Enter'] },
            { action: 'New line in the same paragraph', keys: ['Shift-Enter'] },
        ],
    },
    {
        id: 'lists',
        title: 'Lists',
        where: 'While editing, in a list',
        shortcuts: [
            { action: 'New item, or end the list from an empty one', keys: ['Enter'] },
            { action: 'Move the item in, under the one above', keys: ['Tab'] },
            { action: 'Move the item back out', keys: ['Shift-Tab'] },
        ],
    },
    {
        id: 'tables',
        title: 'Tables',
        where: 'While editing, in a table',
        shortcuts: [
            { action: 'Next cell, adding a row after the last one', keys: ['Tab'] },
            { action: 'Previous cell', keys: ['Shift-Tab'] },
        ],
    },
    {
        id: 'history',
        title: 'Undo',
        where: 'While editing',
        shortcuts: [
            { action: 'Undo', keys: ['Mod-z'] },
            { action: 'Redo', keys: ['Mod-Shift-z', 'Mod-y'] },
        ],
    },
    {
        id: 'insert',
        title: 'The insert menu',
        where: 'While editing, at the start of a line or after a space',
        shortcuts: [
            { action: 'Open the menu', keys: ['/'] },
            { action: 'Move through the choices', keys: ['ArrowUp', 'ArrowDown'] },
            { action: 'Insert the highlighted one', keys: ['Enter'] },
            { action: 'Close it', keys: ['Escape'] },
        ],
    },
    {
        id: 'search',
        title: 'Search',
        where: 'In the search box at the top of the sidebar',
        shortcuts: [
            { action: 'Move through the results', keys: ['ArrowUp', 'ArrowDown'] },
            { action: 'Open the highlighted result', keys: ['Enter'] },
            { action: 'Clear the search', keys: ['Escape'] },
        ],
    },
    {
        id: 'dialogs',
        title: 'Dialogs',
        where: 'In a dialog, such as New note or Rename',
        shortcuts: [
            { action: 'Save, from the name field', keys: ['Enter'] },
            { action: 'Close without saving', keys: ['Escape'] },
            { action: 'Move between the fields and buttons', keys: ['Tab', 'Shift-Tab'] },
        ],
    },
];
