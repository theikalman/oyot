import { Image } from '@tiptap/extension-image';
import { ResizableNodeView } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { insertImageFromBlob } from '../commands/ImageCommand';
import { Plugin } from '@tiptap/pm/state';
import { PluginKey } from '@tiptap/pm/state';

const ResizableImagePluginKey = new PluginKey('resizableImage');

console.log('[ResizableImage] module loaded');

export const ResizableImage = Image.extend({
    onCreate() {
        console.log('[ResizableImage] extension onCreate called');
    },

    addNodeView() {
        console.log('[ResizableImage] addNodeView factory called');
        return ({ node, getPos, HTMLAttributes, editor }: { node: any, getPos: any, HTMLAttributes: any, editor: any }) => {
            console.log('[ResizableImage] nodeView created for', node.type.name);
            const el = document.createElement('img');
            el.setAttribute('src', HTMLAttributes.src || node.attrs.src || '');
            el.setAttribute('alt', HTMLAttributes.alt || node.attrs.alt || '');
            if (node.attrs.width) el.style.width = `${node.attrs.width}px`;
            if (node.attrs.height) el.style.height = `${node.attrs.height}px`;
            el.style.display = 'block';
            el.style.maxWidth = '100%';

            const nodeView = new ResizableNodeView({
                element: el,
                editor: editor as Editor,
                node: node as ProseMirrorNode,
                getPos: getPos as () => number | undefined,
                onResize: (width: number, height: number) => {
                    el.style.width = `${width}px`;
                    el.style.height = `${height}px`;
                },
                onCommit: (width: number, height: number) => {
                    const pos = getPos();
                    if (pos === undefined) return;
                    (editor as Editor).chain().setNodeSelection(pos).updateAttributes(this.name, { width, height }).run();
                },
                onUpdate: (updatedNode) => {
                    if (updatedNode.type.name !== node.type.name) return false;
                    return true;
                },
                options: {
                    preserveAspectRatio: true,
                    min: { width: 50, height: 50 }
                }
            });

            console.log('[ResizableImage] nodeView created, dom:', nodeView.dom, 'wrapper:', nodeView.wrapper, 'dom children:', nodeView.dom.children.length);
            const dom = nodeView.dom as HTMLElement;
            dom.style.visibility = 'hidden';
            dom.style.pointerEvents = 'none';
            (el as HTMLImageElement).onload = () => {
                dom.style.visibility = '';
                dom.style.pointerEvents = '';
                dom.style.opacity = '1';
                (nodeView.wrapper as HTMLElement).style.visibility = '';
                (nodeView.wrapper as HTMLElement).style.pointerEvents = '';
                const handles = (nodeView.wrapper as HTMLElement).querySelectorAll('[data-resize-handle]');
                handles.forEach(h => ((h as HTMLElement).style.pointerEvents = 'all'));
            };
            return nodeView;
        };
    },

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: ResizableImagePluginKey,
                props: {
                    handlePaste: (_view: any, event: any) => {
                        const items: DataTransferItemList | null = event.clipboardData?.items;
                        if (!items) return false;
                        for (const item of Array.from(items)) {
                            if (item.type.startsWith('image/')) {
                                event.preventDefault();
                                const blob: Blob | null = item.getAsFile();
                                if (blob) insertImageFromBlob(this.editor as Editor, blob);
                                return true;
                            }
                        }
                        return false;
                    },
                    handleDrop: (_view: any, event: any) => {
                        const files: FileList | null = event.dataTransfer?.files;
                        if (!files) return false;
                        for (const file of Array.from(files)) {
                            if (file.type.startsWith('image/')) {
                                event.preventDefault();
                                insertImageFromBlob(this.editor as Editor, file as Blob);
                                return true;
                            }
                        }
                        return false;
                    }
                }
            })
        ];
    }
});