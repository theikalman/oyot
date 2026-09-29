// What the help page says about typing in a note, beyond its keyboard
// shortcuts ($lib/keyboard/shortcuts): the Markdown the editor turns into
// formatting as it is typed, the symbols it swaps in, and the insert menu.
// shortcuts.test.ts holds the insert menu to the one the editor registers.

/** Something typed in a note that the editor turns into something else. */
export interface TypedShortcut {
    /** What to type. */
    typed: string;
    /** What it becomes. */
    becomes: string;
}

/**
 * Typed at the start of a line and followed by a space, the way Markdown
 * writes them.
 */
export const LINE_STARTS: readonly TypedShortcut[] = [
    { typed: '#', becomes: 'Heading 1' },
    { typed: '##', becomes: 'Heading 2' },
    { typed: '###', becomes: 'Heading 3' },
    { typed: '-', becomes: 'Bulleted list' },
    { typed: '1.', becomes: 'Numbered list' },
    { typed: '[ ]', becomes: 'Task' },
    { typed: '[x]', becomes: 'Task, already ticked' },
    { typed: '>', becomes: 'Quote' },
    { typed: '```', becomes: 'Code block' },
];

/** Typed on a line of its own, with no space needed after it. */
export const DIVIDER: TypedShortcut = { typed: '---', becomes: 'A line across the page' };

/** Wrapped around a few words, which take the style when the second mark is typed. */
export const AROUND_WORDS: readonly TypedShortcut[] = [
    { typed: '**words**', becomes: 'Bold' },
    { typed: '*words*', becomes: 'Italic' },
    { typed: '~~words~~', becomes: 'Strikethrough' },
    { typed: '`words`', becomes: 'Inline code' },
];

/** Characters the editor swaps for the symbol they stand for, as they are typed. */
export const SYMBOLS: readonly TypedShortcut[] = [
    { typed: '->', becomes: '→' },
    { typed: '<-', becomes: '←' },
    { typed: '...', becomes: '…' },
    { typed: '!=', becomes: '≠' },
    { typed: '+/-', becomes: '±' },
    { typed: '(c)', becomes: '©' },
];

/** One entry in the menu that `/` opens, by the name the menu shows. */
export interface InsertCommand {
    /** The command's id in the slash menu's registry. */
    id: string;
    label: string;
    does: string;
}

/** The insert menu's entries, in the order it lists them. */
export const INSERT_COMMANDS: readonly InsertCommand[] = [
    {
        id: 'document',
        label: 'Link Document',
        does: 'A link to another note or journal. Pick it from a list, which narrows as you type.',
    },
    { id: 'date', label: 'Insert Date', does: "Today's date, written out in full." },
    { id: 'todo', label: 'Insert Todo', does: 'A task, with a box to tick.' },
    {
        id: 'tag',
        label: 'Insert Tag',
        does: 'A tag. Pick one you have used before, or type a new name.',
    },
    {
        id: 'image',
        label: 'Insert Image',
        does: 'An image from a file. Pasting one in, or dragging one in, works too.',
    },
];
