import type { Editor } from '@tiptap/core';
import { insertImageFromFile } from '$lib/tiptap/commands/ImageCommand';

// The editing toolbar's tools, in the order it shows them. Described as data
// rather than written out as markup, so every button is drawn the one way and
// what each does can be read in one place.

/** One button on the editing toolbar. */
export interface Tool {
    /** Unique across the toolbar. */
    id: string;
    /** What pressing it does: its tooltip, and the name a screen reader reads. */
    label: string;
    /**
     * Path data for its icon, on a 24-unit square. The toolbar strokes every
     * icon the same way, so these carry the shape and nothing else.
     */
    icon: readonly string[];
    run: (editor: Editor) => void;
}

// The letter H the three heading icons share, each with its own digit.
const H = ['M4 6v12', 'M12 6v12', 'M4 12h8'];

// A rounded frame, the one the image icon has, so the two insert tools that
// sit side by side are the same size.
const FRAME =
    'M6.8 21h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 18.72 22 17.88 22 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 3 18.88 3 17.2 3H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 5.28 2 6.12 2 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 21 5.12 21 6.8 21';

/** Changing how text looks and what kind of block it is, in groups. */
export const FORMATTING: readonly (readonly Tool[])[] = [
    [
        {
            id: 'bold',
            label: 'Bold',
            icon: ['M7 5h5.5a3.5 3.5 0 0 1 0 7H7z', 'M7 12h6.5a3.5 3.5 0 0 1 0 7H7z'],
            run: (editor) => editor.chain().focus().toggleBold().run(),
        },
        {
            id: 'italic',
            label: 'Italic',
            icon: ['M11 5h7', 'M6 19h7', 'M14.5 5l-5 14'],
            run: (editor) => editor.chain().focus().toggleItalic().run(),
        },
        {
            id: 'strike',
            label: 'Strikethrough',
            icon: [
                'M4 12h16',
                'M16.3 7.2C15.7 5.6 14 4.5 12 4.5c-2.5 0-4.3 1.5-4.3 3.4 0 1.5 1 2.6 2.8 3.2',
                'M15.2 13.4c.8.6 1.2 1.4 1.2 2.4 0 2.1-1.9 3.7-4.4 3.7-2.2 0-4-1.1-4.6-2.8',
            ],
            run: (editor) => editor.chain().focus().toggleStrike().run(),
        },
    ],
    [
        {
            id: 'heading1',
            label: 'Heading 1',
            icon: [...H, 'M16.5 11.5 19 10v8'],
            run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        },
        {
            id: 'heading2',
            label: 'Heading 2',
            icon: [...H, 'M16.5 12a2.25 2.25 0 1 1 3.9 1.5L16.5 18h4.5'],
            run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
            id: 'heading3',
            label: 'Heading 3',
            icon: [...H, 'M16.5 10h4l-1.9 3.2a2.4 2.4 0 1 1-2.08 3.6'],
            run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        },
    ],
    [
        {
            id: 'bulletList',
            label: 'Bulleted list',
            icon: [
                'M9 6h11',
                'M9 12h11',
                'M9 18h11',
                'M4 5.25a.75.75 0 1 0 0 1.5.75.75 0 1 0 0-1.5',
                'M4 11.25a.75.75 0 1 0 0 1.5.75.75 0 1 0 0-1.5',
                'M4 17.25a.75.75 0 1 0 0 1.5.75.75 0 1 0 0-1.5',
            ],
            run: (editor) => editor.chain().focus().toggleBulletList().run(),
        },
        {
            id: 'orderedList',
            label: 'Numbered list',
            icon: [
                'M10 6h10',
                'M10 12h10',
                'M10 18h10',
                'M4 5 5.5 4v5',
                'M4 9h3',
                'M4.2 15a1.4 1.4 0 0 1 2.7.5c0 1-2.9 2-2.9 3.5h3',
            ],
            run: (editor) => editor.chain().focus().toggleOrderedList().run(),
        },
        {
            id: 'taskList',
            label: 'Task list',
            icon: [
                'm3.5 6.5 1.75 1.75L8.5 5',
                'M4.5 14.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
                'M12 7h8',
                'M12 17h8',
            ],
            run: (editor) => editor.chain().focus().toggleTaskList().run(),
        },
    ],
    [
        {
            id: 'blockquote',
            label: 'Quote',
            icon: [
                'M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5c0 3-1.5 5-4.5 6',
                'M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5c0 3-1.5 5-4.5 6',
            ],
            run: (editor) => editor.chain().focus().toggleBlockquote().run(),
        },
        {
            id: 'codeBlock',
            label: 'Code block',
            icon: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13.5 6-3 12'],
            run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
        },
        {
            id: 'table',
            label: 'Insert table',
            icon: [FRAME, 'M2 9h20', 'M2 15h20', 'M9 9v12'],
            run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3 }).run(),
        },
        {
            id: 'image',
            label: 'Insert image',
            // The slash menu's image icon, so the two ways in look alike.
            icon: [
                'm4.272 20.728 6.597-6.597c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668l6.553 6.553M14 15l2.869-2.869c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668L22 15M10 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
                FRAME,
            ],
            run: (editor) => void insertImageFromFile(editor),
        },
    ],
];

/** Stepping back and forward through the changes made here. */
export const HISTORY: readonly Tool[] = [
    {
        id: 'undo',
        label: 'Undo',
        icon: ['M4 9h11a5 5 0 0 1 0 10h-3', 'M8 5 4 9l4 4'],
        run: (editor) => editor.chain().focus().undo().run(),
    },
    {
        id: 'redo',
        label: 'Redo',
        icon: ['M20 9H9a5 5 0 0 0 0 10h3', 'm16 5 4 4-4 4'],
        run: (editor) => editor.chain().focus().redo().run(),
    },
];
