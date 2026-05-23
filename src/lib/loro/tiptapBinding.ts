import type { Editor } from '@tiptap/core';
import { LoroApp } from './loroApp';

export interface TiptapBindingOptions {
    editor: Editor;
    loroApp: LoroApp;
    contentContainer?: string;
}

export class TiptapBinding {
    private editor: Editor;
    private loroApp: LoroApp;
    private contentContainer: string;
    private isApplyingRemoteChange: boolean = false;

    constructor(options: TiptapBindingOptions) {
        this.editor = options.editor;
        this.loroApp = options.loroApp;
        this.contentContainer = options.contentContainer || 'content';

        this.setupLoroListener();
        this.setupEditorListener();
    }

    private setupEditorListener(): void {
        this.editor.on('update', ({ editor }) => {
            if (this.isApplyingRemoteChange) {
                return;
            }
        });
    }

    private setupLoroListener(): void {
        this.loroApp.subscribe((event: any) => {
            this.handleRemoteChange();
        });
    }

    private handleRemoteChange(): void {
        if (this.isApplyingRemoteChange) {
            return;
        }

        this.isApplyingRemoteChange = true;

        try {
            const content = this.loroApp.getJsonContent();
            const parsed = JSON.parse(content);

            const currentJson = JSON.stringify(this.editor.getJSON());
            if (currentJson !== content) {
                this.editor.commands.setContent(parsed);
            }
        } catch (error) {
            console.error('[TiptapBinding] Failed to apply remote change:', error);
        } finally {
            this.isApplyingRemoteChange = false;
        }
    }

    loadContent(content: string): void {
        this.isApplyingRemoteChange = true;

        try {
            const parsed = JSON.parse(content);
            this.editor.commands.setContent(parsed);
        } catch (error) {
            console.error('[TiptapBinding] Failed to load content:', error);
            const initialContent = {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: []
                    }
                ]
            };
            this.editor.commands.setContent(initialContent);
        } finally {
            this.isApplyingRemoteChange = false;
        }
    }

    destroy(): void {
        // Cleanup listeners if needed
        this.isApplyingRemoteChange = false;
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