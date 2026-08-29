import { Image } from '@tiptap/extension-image';
import { ResizableNodeView } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { insertImageFromBlob } from '../commands/ImageCommand';
import {
    ATTACHMENT_SCHEME,
    PENDING_IMAGE_SRC,
    attachmentHash,
    isLegacyBakedSrc,
    onAttachmentReady,
    requestAttachment,
    resolveAttachmentSrc,
} from '../attachments';
import { Plugin } from '@tiptap/pm/state';
import { PluginKey } from '@tiptap/pm/state';

const ResizableImagePluginKey = new PluginKey('resizableImage');

// One-off rewrite of image nodes that still carry a device-local baked `src`
// (from before attachments were content-addressed). Recovers the hash and
// replaces the src with the portable `oyot-attachment://` scheme, which also
// propagates the fix to paired devices on the next sync.
function migrateLegacyImageSrcs(editor: Editor): void {
    const fixes: Array<{ pos: number; src: string }> = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'image') return;
        const src: string | null = node.attrs.src ?? null;
        if (!isLegacyBakedSrc(src)) return;
        const hash = attachmentHash(src, node.attrs.alt);
        if (hash) fixes.push({ pos, src: `${ATTACHMENT_SCHEME}${hash}` });
    });
    if (fixes.length === 0) return;

    let tr = editor.state.tr;
    for (const { pos, src } of fixes) tr = tr.setNodeAttribute(pos, 'src', src);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
}

export const ResizableImage = Image.extend({
    onCreate() {
        // Deferred a tick: dispatching a transaction synchronously inside
        // onCreate races the collaboration plugin's own setup.
        const editor = this.editor as Editor;
        setTimeout(() => {
            if (editor.isDestroyed) return;
            try {
                migrateLegacyImageSrcs(editor);
            } catch (e) {
                console.warn('[ResizableImage] legacy src migration failed:', e);
            }
        }, 0);
    },

    addNodeView() {
        return ({ node, getPos, HTMLAttributes, editor }: { node: any, getPos: any, HTMLAttributes: any, editor: any }) => {
            const el = document.createElement('img');
            el.setAttribute('alt', HTMLAttributes.alt || node.attrs.alt || '');

            // Resolve the stored reference to something the webview can load.
            // Never assign the raw `oyot-attachment://` scheme - that is what
            // produced "Failed to load resource" in the console.
            const rawSrc: string = node.attrs.src || HTMLAttributes.src || '';
            const hash = attachmentHash(rawSrc, node.attrs.alt);
            let unsubscribe: (() => void) | null = null;

            if (hash) {
                el.setAttribute('src', PENDING_IMAGE_SRC);
                const applyResolved = async () => {
                    const url = await resolveAttachmentSrc(hash);
                    if (url) {
                        el.setAttribute('src', url);
                        unsubscribe?.();
                        unsubscribe = null;
                    }
                };
                void applyResolved().then(() => {
                    if (el.getAttribute('src') === PENDING_IMAGE_SRC) {
                        requestAttachment(hash);
                        unsubscribe = onAttachmentReady(hash, () => void applyResolved());
                    }
                });
            } else {
                el.setAttribute('src', rawSrc);
            }

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

            const anyView = nodeView as unknown as { destroy?: () => void };
            const origDestroy = anyView.destroy?.bind(nodeView);
            anyView.destroy = () => {
                unsubscribe?.();
                unsubscribe = null;
                origDestroy?.();
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