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
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { IMAGE_ALIGNS, alignOf, storedAlign, type ImageAlign } from '../imageAttrs';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        resizableImage: {
            /** Move the selected image to the left, centre or right of its line. */
            setImageAlign: (align: ImageAlign) => ReturnType;
        };
    }
}

// Icons on a 24-unit square, stroked the way the editing toolbar strokes its own.
const ICONS: Record<ImageAlign, string[]> = {
    left: ['M4 5h16', 'M4 10h10', 'M4 14h16', 'M4 19h10'],
    center: ['M4 5h16', 'M7 10h10', 'M4 14h16', 'M7 19h10'],
    right: ['M4 5h16', 'M10 10h10', 'M4 14h16', 'M10 19h10'],
};

const LABELS: Record<ImageAlign, string> = {
    left: 'Align left',
    center: 'Align centre',
    right: 'Align right',
};

function iconSvg(paths: string[]): string {
    const d = paths.map((path) => `<path d="${path}"/>`).join('');
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

// A flex container lays the image out, so its line position is where the
// container puts its one child.
const JUSTIFY: Record<ImageAlign, string> = {
    left: 'flex-start',
    center: 'center',
    right: 'flex-end',
};

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
    addAttributes() {
        return {
            ...this.parent?.(),
            // Null for left, so a note nobody aligns is stored as before.
            align: {
                default: null,
                parseHTML: (element: HTMLElement) =>
                    storedAlign(element.getAttribute('data-align')),
                renderHTML: (attributes: Record<string, unknown>) => {
                    const align = storedAlign(attributes.align);
                    return align ? { 'data-align': align } : {};
                },
            },
        };
    },

    addCommands() {
        return {
            ...this.parent?.(),
            setImageAlign:
                (align: ImageAlign) =>
                ({ state, tr, dispatch }) => {
                    const { selection } = state;
                    if (!(selection instanceof NodeSelection)) return false;
                    if (selection.node.type.name !== this.name) return false;
                    if (dispatch) {
                        tr.setNodeAttribute(selection.from, 'align', storedAlign(align));
                        tr.setSelection(NodeSelection.create(tr.doc, selection.from));
                    }
                    return true;
                },
        };
    },

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
        return ({
            node,
            getPos,
            HTMLAttributes,
            editor,
        }: {
            node: any;
            getPos: any;
            HTMLAttributes: any;
            editor: any;
        }) => {
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
                        // The placeholder is a 1x1 pixel, so without clearing
                        // this the real image would be drawn at that size.
                        el.classList.remove('attachment-pending');
                        unsubscribe?.();
                        unsubscribe = null;
                    }
                };
                void applyResolved().then(() => {
                    if (el.getAttribute('src') === PENDING_IMAGE_SRC) {
                        // A transparent 1x1 pixel is indistinguishable from
                        // nothing being there. Mark it so the stylesheet can
                        // show that an image is on its way from another
                        // device rather than leaving a gap.
                        el.classList.add('attachment-pending');
                        requestAttachment(hash);
                        unsubscribe = onAttachmentReady(hash, () => void applyResolved());
                    }
                });
            } else {
                el.setAttribute('src', rawSrc);
            }

            // Width is the stored dimension; height follows from it. Setting
            // both pixel values together with `max-width: 100%` meant a
            // resized image squashed on any screen narrower than the width it
            // was resized at: the width shrank and the height did not.
            if (node.attrs.width) el.style.width = `${node.attrs.width}px`;
            el.style.height = 'auto';
            if (node.attrs.width && node.attrs.height) {
                el.style.aspectRatio = `${node.attrs.width} / ${node.attrs.height}`;
            }
            el.style.display = 'block';
            el.style.maxWidth = '100%';

            const nodeView = new ResizableNodeView({
                element: el,
                editor: editor as Editor,
                node: node as ProseMirrorNode,
                getPos: getPos as () => number | undefined,
                onResize: (width: number, height: number) => {
                    el.style.width = `${width}px`;
                    el.style.aspectRatio = `${width} / ${height}`;
                },
                onCommit: (width: number, height: number) => {
                    const pos = getPos();
                    if (pos === undefined) return;
                    (editor as Editor)
                        .chain()
                        .setNodeSelection(pos)
                        .updateAttributes(this.name, { width, height })
                        .run();
                },
                onUpdate: (updatedNode) => {
                    if (updatedNode.type.name !== node.type.name) return false;
                    current = updatedNode as ProseMirrorNode;
                    applyAlign();
                    return true;
                },
                options: {
                    preserveAspectRatio: true,
                    min: { width: 50, height: 50 },
                },
            });

            const dom = nodeView.dom as HTMLElement;
            const wrapper = nodeView.wrapper as HTMLElement;
            let current = node as ProseMirrorNode;

            // The image's own toolbar, shown by the stylesheet while it is
            // selected for editing. In the node view rather than floating
            // over the page, so it scrolls with the image and needs no
            // positioning of its own.
            const toolbar = document.createElement('div');
            toolbar.className = 'image-toolbar';
            toolbar.contentEditable = 'false';
            toolbar.setAttribute('role', 'toolbar');
            toolbar.setAttribute('aria-label', 'Image');
            const buttons = new Map<ImageAlign, HTMLButtonElement>();
            const addButton = (id: ImageAlign, run: () => void) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'image-toolbar-btn';
                button.dataset.action = id;
                button.title = LABELS[id];
                button.setAttribute('aria-label', LABELS[id]);
                button.innerHTML = iconSvg(ICONS[id]);
                // Held, so the press does not take the editor's focus or
                // the image's selection with it.
                button.addEventListener('mousedown', (e) => e.preventDefault());
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    run();
                });
                buttons.set(id, button);
                toolbar.appendChild(button);
            };
            for (const align of IMAGE_ALIGNS) {
                addButton(align, () =>
                    (editor as Editor).chain().focus().setImageAlign(align).run(),
                );
            }
            wrapper.appendChild(toolbar);

            const applyAlign = () => {
                const align = alignOf(current.attrs.align);
                dom.dataset.align = align;
                dom.style.justifyContent = JUSTIFY[align];
                for (const option of IMAGE_ALIGNS) {
                    buttons.get(option)?.setAttribute('aria-pressed', String(option === align));
                }
            };
            applyAlign();

            // Presses on the toolbar are the toolbar's, not the editor's.
            (nodeView as unknown as { stopEvent: (e: Event) => boolean }).stopEvent = (e) =>
                toolbar.contains(e.target as globalThis.Node);

            dom.style.visibility = 'hidden';
            dom.style.pointerEvents = 'none';
            (el as HTMLImageElement).onload = () => {
                dom.style.visibility = '';
                dom.style.pointerEvents = '';
                dom.style.opacity = '1';
                (nodeView.wrapper as HTMLElement).style.visibility = '';
                (nodeView.wrapper as HTMLElement).style.pointerEvents = '';
                const handles = (nodeView.wrapper as HTMLElement).querySelectorAll(
                    '[data-resize-handle]',
                );
                handles.forEach((h) => ((h as HTMLElement).style.pointerEvents = 'all'));
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
                    },
                },
            }),
        ];
    },
});
