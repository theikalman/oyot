import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { CONTENT_FIELD } from './contentField';

// The Yjs helpers EditorInstance needs. Loading a document's state now goes
// through `DocumentRepository.openDocument`, which registers the resulting
// Y.Doc as the open copy in the same queued step, so the sync layer can apply a
// peer's edit straight into it.

export function createCollaborationExtension(ydoc: Y.Doc, fieldName: string = CONTENT_FIELD) {
    return Collaboration.configure({
        document: ydoc,
        field: fieldName,
    });
}
