import { Extension } from '@tiptap/core';
import { keymap } from '@tiptap/pm/keymap';
import { loadLoroModules } from './lazyLoader';

export interface LoroEditorExtensionOptions {
    loroDoc: any;
    presence?: any;
}

let extensionCreated = false;

export const LoroEditorExtension = Extension.create<LoroEditorExtensionOptions>({
    name: 'loroEditor',

    addProseMirrorPlugins() {
        return [];
    },
});

export async function addLoroPluginsToEditor(editor: any, loroDoc: any, presence?: any) {
    const loro = await loadLoroModules();

    const plugins: any[] = [];

    if (loroDoc) {
        plugins.push(
            loro.LoroSyncPlugin({
                doc: loroDoc,
            })
        );

        plugins.push(
            loro.LoroUndoPlugin({
                doc: loroDoc,
            })
        );
    }

    plugins.push(
        keymap({
            'Mod-z': loro.undo,
            'Mod-y': loro.redo,
            'Mod-Shift-z': loro.redo,
        })
    );

    if (presence) {
        plugins.push(
            loro.LoroEphemeralCursorPlugin(presence, {})
        );
    }

    for (const plugin of plugins) {
        editor.registerPlugin(plugin);
    }

    return plugins;
}

export async function createLoroDoc(): Promise<any> {
    const { LoroDoc } = await import('loro-crdt');
    return new LoroDoc();
}

export async function createPresenceStore(loroDoc: any, timeout?: number): Promise<any> {
    const loro = await loadLoroModules();
    return new loro.CursorEphemeralStore(loroDoc.peerIdStr as `${number}`, timeout);
}

export async function loadLoroDocFromState(state: Uint8Array): Promise<any> {
    const { LoroDoc } = await import('loro-crdt');
    if (state.length === 0) {
        return createLoroDoc();
    }
    return LoroDoc.fromSnapshot(state);
}

export function exportLoroDocUpdate(loroDoc: any): Uint8Array {
    return loroDoc.export({
        mode: 'update',
    });
}

export function exportLoroDocSnapshot(loroDoc: any): Uint8Array {
    return loroDoc.export({
        mode: 'snapshot',
    });
}

export function getLoroDocStateVector(loroDoc: any): Uint8Array {
    return loroDoc.oplogVersion().encode();
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
