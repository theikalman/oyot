import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

// The Yjs helpers EditorInstance needs. Loading a document's state now goes
// through `DocumentRepository.openDocument`, which registers the resulting
// Y.Doc as the open copy in the same queued step, so the sync layer can apply a
// peer's edit straight into it.

export function createInitialContent(title: string): object {
    return {
        type: 'doc',
        content: [
            {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: title }],
            },
            {
                type: 'paragraph',
                content: [],
            },
        ],
    };
}

export function createCollaborationExtension(ydoc: Y.Doc, fieldName: string = 'content') {
    return Collaboration.configure({
        document: ydoc,
        field: fieldName,
    });
}
