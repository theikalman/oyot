import { Extension } from '@tiptap/core';
import { keymap } from '@tiptap/pm/keymap';
import * as Y from 'yjs';
import { ySyncPlugin, yUndoPlugin, yCursorPlugin, undo, redo, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { Awareness } from 'y-protocols/awareness';

export interface CollabEditorExtensionOptions {
    doc: Y.Doc;
    awareness?: Awareness;
}

export const CollabEditorExtension = Extension.create<CollabEditorExtensionOptions>({
    name: 'collabEditor',

    addProseMirrorPlugins() {
        return [];
    },
});

export async function addLoroPluginsToEditor(editor: any, yDoc: Y.Doc, awareness?: Awareness) {
    const fragment = yDoc.getXmlFragment('prosemirror');

    // If the fragment is empty (new document), seed it from the editor's current content.
    // This prevents ySyncPlugin's _forceRerender() from trying to replace the editor
    // with an empty fragment, which would produce an invalid ProseMirror document.
    if (fragment.length === 0) {
        prosemirrorJSONToYXmlFragment(editor.schema, editor.getJSON(), fragment);
    }

    const plugins: any[] = [];

    plugins.push(ySyncPlugin(fragment));
    plugins.push(yUndoPlugin());

    plugins.push(
        keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Mod-Shift-z': redo,
        })
    );

    if (awareness) {
        plugins.push(yCursorPlugin(awareness));
    }

    for (const plugin of plugins) {
        editor.registerPlugin(plugin);
    }

    return plugins;
}

export function createLoroDoc(): Y.Doc {
    return new Y.Doc();
}

export async function createPresenceStore(yDoc: Y.Doc, _timeout?: number): Promise<Awareness> {
    return new Awareness(yDoc);
}

export function loadLoroDocFromState(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    if (state.length > 0) {
        try {
            Y.applyUpdate(doc, state);
        } catch (e) {
            // Stored bytes are in an incompatible format (e.g. old Loro binary).
            // Return a fresh empty doc so the editor can still open.
            console.warn('[collab] Could not apply stored state, starting fresh:', e);
            return new Y.Doc();
        }
    }
    return doc;
}

export function exportLoroDocUpdate(yDoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(yDoc);
}

export function exportLoroDocSnapshot(yDoc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(yDoc);
}

export function getLoroDocStateVector(yDoc: Y.Doc): Uint8Array {
    return Y.encodeStateVector(yDoc);
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
