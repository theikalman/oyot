import { Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

export interface YjsEditorExtensionOptions {
    ydoc: Y.Doc;
    fieldName?: string;
    user?: { name: string; color: string };
}

export const YjsEditorExtension = Extension.create<YjsEditorExtensionOptions>({
    name: 'yjsEditor',

    addProseMirrorPlugins() {
        return [];
    },
});

export function createYjsDoc(): Y.Doc {
    return new Y.Doc();
}

export function loadYjsDocFromState(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    if (state.length > 0) {
        Y.applyUpdate(doc, state);
    }
    return doc;
}

export function exportYjsDocSnapshot(ydoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(ydoc);
}

export function exportYjsDocUpdate(ydoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(ydoc);
}

export function applyYjsUpdate(ydoc: Y.Doc, update: Uint8Array): Y.Doc {
    Y.applyUpdate(ydoc, update);
    return ydoc;
}

export function createInitialContent(title: string): object {
    return {
        type: 'doc',
        content: [
            {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: title }]
            },
            {
                type: 'paragraph',
                content: []
            }
        ]
    };
}

export function isEmptyContent(content: string | object): boolean {
    if (typeof content === 'string') {
        try {
            const parsed = JSON.parse(content);
            content = parsed;
        } catch {
            return true;
        }
    }

    const doc = content as { type: string; content?: unknown[] };
    if (!doc.content || doc.content.length === 0) {
        return true;
    }

    if (doc.content.length === 1) {
        const first = doc.content[0] as { type: string; content?: unknown[] };
        if (first.type === 'paragraph' && (!first.content || first.content.length === 0)) {
            return true;
        }
    }

    return false;
}

export function createCollaborationExtension(ydoc: Y.Doc, fieldName: string = 'content') {
    return Collaboration.configure({
        document: ydoc,
        field: fieldName,
    });
}