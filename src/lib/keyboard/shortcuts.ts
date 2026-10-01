// Every keyboard shortcut Oyot has: the keys, what they do, and where. The
// help page lists them all, and the ones with an id can be changed in
// Settings.
//
// Written out here rather than read off the editor, because most of these
// reach the app by way of a library and have to be put in words a person
// uses. shortcuts.test.ts holds the list to the editor's real key bindings
// and the toolbar's, so the page cannot promise a key that does nothing or
// leave out one the toolbar names.

/** One thing a key does. */
export interface Shortcut {
    /**
     * For a shortcut the user can change, the name its keys are stored
     * under, which is also the toolbar tool's id for one the toolbar has.
     * Never changed once released: a stored shortcut would lose its keys.
     * Left out of keys that do different things in different places, such
     * as Enter and Tab, which cannot be changed.
     */
    id?: string;
    /** What pressing it does. */
    action: string;
    /**
     * The keys, in the editor's notation (`Mod-Shift-z`), which
     * `shortcutLabel` writes the way the keyboard in front of the user
     * labels them. More than one when any of them will do. For a shortcut
     * the user can change, the keys it has until they do.
     */
    keys: readonly string[];
}

/** A shortcut the user can change. */
export type ChangeableShortcut = Shortcut & { id: string };

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
        // Mod-/ because the editor leaves it free, and it is where a number
        // of apps keep their list of shortcuts. Plain / is the editor's, for
        // the insert menu. The pages under Index by their place in it, as
        // apps number the places down their sidebar; the editor leaves Mod
        // and a digit free, since its headings are Mod-Alt and one. Settings
        // on Mod-, as in most apps on a Mac.
        shortcuts: [
            { id: 'help', action: 'Open the help page', keys: ['Mod-/'] },
            { id: 'search', action: 'Open the Search page', keys: ['Mod-1'] },
            { id: 'notes', action: 'Open the Notes page', keys: ['Mod-2'] },
            { id: 'journals', action: 'Open the Journals page', keys: ['Mod-3'] },
            { id: 'todos', action: 'Open the Todos page', keys: ['Mod-4'] },
            { id: 'tags', action: 'Open the Tags page', keys: ['Mod-5'] },
            { id: 'settings', action: 'Open Settings', keys: ['Mod-,'] },
        ],
    },
    {
        id: 'document',
        title: 'Notes and journals',
        where: 'On any open note or journal',
        shortcuts: [
            { id: 'edit', action: 'Switch between reading and editing', keys: ['Mod-Shift-e'] },
        ],
    },
    {
        id: 'text',
        title: 'Text',
        where: 'While editing, on the selected text or on what you type next',
        shortcuts: [
            { id: 'bold', action: 'Bold', keys: ['Mod-b'] },
            { id: 'italic', action: 'Italic', keys: ['Mod-i'] },
            { id: 'underline', action: 'Underline', keys: ['Mod-u'] },
            { id: 'strike', action: 'Strikethrough', keys: ['Mod-Shift-s'] },
            { id: 'code', action: 'Inline code', keys: ['Mod-e'] },
        ],
    },
    {
        id: 'blocks',
        title: 'Headings and blocks',
        where: 'While editing, on the paragraph the cursor is in',
        shortcuts: [
            { id: 'heading1', action: 'Heading 1', keys: ['Mod-Alt-1'] },
            { id: 'heading2', action: 'Heading 2', keys: ['Mod-Alt-2'] },
            { id: 'heading3', action: 'Heading 3', keys: ['Mod-Alt-3'] },
            { id: 'heading4', action: 'Heading 4', keys: ['Mod-Alt-4'] },
            { id: 'heading5', action: 'Heading 5', keys: ['Mod-Alt-5'] },
            { id: 'heading6', action: 'Heading 6', keys: ['Mod-Alt-6'] },
            { id: 'paragraph', action: 'Normal text', keys: ['Mod-Alt-0'] },
            { id: 'bulletList', action: 'Bulleted list', keys: ['Mod-Shift-8'] },
            { id: 'orderedList', action: 'Numbered list', keys: ['Mod-Shift-7'] },
            { id: 'taskList', action: 'Task list', keys: ['Mod-Shift-9'] },
            { id: 'blockquote', action: 'Quote', keys: ['Mod-Shift-b'] },
            { id: 'codeBlock', action: 'Code block', keys: ['Mod-Alt-c'] },
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
            { id: 'undo', action: 'Undo', keys: ['Mod-z'] },
            { id: 'redo', action: 'Redo', keys: ['Mod-Shift-z', 'Mod-y'] },
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
        where: 'In the box on the Search page',
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

/** Every shortcut the user can change, in the order the list has them. */
export const CHANGEABLE_SHORTCUTS: readonly ChangeableShortcut[] = SHORTCUT_GROUPS.flatMap(
    (group) => group.shortcuts,
).filter((shortcut): shortcut is ChangeableShortcut => shortcut.id !== undefined);

/** The shortcut the user can change that has `id`, if there is one. */
export function changeableShortcut(id: string): ChangeableShortcut | undefined {
    return CHANGEABLE_SHORTCUTS.find((shortcut) => shortcut.id === id);
}
