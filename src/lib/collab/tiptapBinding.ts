import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';

export interface YjsBindingOptions {
    editor: Editor;
    yDoc: Y.Doc;
}

/**
 * YjsBinding bridges a Tiptap editor with a Y.Doc.
 * Note: with y-prosemirror's ySyncPlugin installed, the XmlFragment
 * ('prosemirror') is the source of truth. This class is kept for API
 * compatibility but the ySyncPlugin handles all real-time sync.
 */
export class TiptapBinding {
    private editor: Editor;
    private yDoc: Y.Doc;
    private updateHandler: (() => void) | null = null;

    constructor(options: YjsBindingOptions) {
        this.editor = options.editor;
        this.yDoc = options.yDoc;
    }

    destroy(): void {
        if (this.updateHandler) {
            this.yDoc.off('update', this.updateHandler);
            this.updateHandler = null;
        }
    }
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
