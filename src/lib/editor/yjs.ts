import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

// The three Yjs helpers EditorInstance actually needs. What used to live in
// $lib/yjs/YjsEditorExtension.ts alongside them -- a Tiptap Extension whose
// addProseMirrorPlugins returned [], plus four exported functions -- was never
// imported anywhere.

export function loadYjsDocFromState(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    if (state.length > 0) {
        Y.applyUpdate(doc, state);
    }
    return doc;
}

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
