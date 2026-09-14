import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import Typography from '@tiptap/extension-typography';
import type { Extensions } from '@tiptap/core';
import { DocumentLinkNode } from '$lib/tiptap/nodes/DocumentLinkNode';
import { ResizableImage } from '$lib/tiptap/extensions/ResizableImage';

/**
 * What a document is made of: every extension that contributes a node or a
 * mark, and so defines the schema.
 *
 * Shared rather than inlined in the editor component because the sync layer
 * needs the same schema to read a document it has merged but never displayed.
 * A second declaration kept in step by hand would fail silently, by dropping
 * the nodes it had not been told about.
 *
 * Deliberately excludes everything that is interaction rather than content:
 * the Yjs binding, the slash menu, the placeholder, the paste handlers, the
 * keyboard-aware scrolling. Those belong to a live editor, they contribute
 * nothing to the schema, and keeping them out is what lets this be imported
 * somewhere there is no DOM.
 */
export function createContentExtensions(): Extensions {
    return [
        StarterKit.configure({
            undoRedo: false,
        }),
        ResizableImage.configure({
            inline: false,
            allowBase64: true,
        }),
        TaskList,
        TaskItem.configure({
            nested: true,
        }),
        Table.configure({
            resizable: true,
        }),
        TableRow,
        TableHeader,
        TableCell,
        Typography,
        DocumentLinkNode,
    ];
}
