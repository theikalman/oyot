import { Node, mergeAttributes } from '@tiptap/core';

export interface DocumentLinkOptions {
    HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        documentLink: {
            setDocumentLink: (attributes: { targetId: string; title: string }) => ReturnType;
        };
    }
}

export const DocumentLinkNode = Node.create<DocumentLinkOptions>({
    name: 'documentLink',

    group: 'inline',

    inline: true,

    atom: true,

    addOptions() {
        return {
            HTMLAttributes: {}
        };
    },

    addAttributes() {
        return {
            targetId: {
                default: null,
                parseHTML: element => element.getAttribute('data-target-id'),
                renderHTML: attributes => {
                    if (!attributes.targetId) return {};
                    return { 'data-target-id': attributes.targetId };
                }
            },
            title: {
                default: null,
                parseHTML: element => element.getAttribute('data-title'),
                renderHTML: attributes => {
                    if (!attributes.title) return {};
                    return { 'data-title': attributes.title };
                }
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-type="document-link"]'
            }
        ];
    },

    renderHTML({ HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                'data-type': 'document-link',
                class: 'document-link'
            }),
            [
                'span',
                { class: 'document-link-icon' },
                ['svg', { xmlns: 'http://www.w3.org/2000/svg', fill: 'none', viewBox: '0 0 24 24', width: '100%', height: '100%' }, ['path', { stroke: '#664FC2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-width': '1.5', d: 'M12.5 2h2.7c1.68 0 2.52 0 3.162.327a3 3 0 0 1 1.311 1.311C20 4.28 20 5.12 20 6.8v10.4c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C17.72 22 16.88 22 15.2 22H8.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C4 19.72 4 18.88 4 17.2v-.7M16 13h-4.5M16 9h-3.5m3.5 8H8m-2-7V4.5a1.5 1.5 0 1 1 3 0V10a3 3 0 1 1-6 0V6' }]]
            ],
            [
                'span',
                { class: 'document-link-title' },
                HTMLAttributes['data-title'] || ''
            ]
        ];
    },

    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement('span');
            dom.setAttribute('data-type', 'document-link');
            dom.className = 'document-link';
            dom.setAttribute('data-target-id', node.attrs.targetId || '');
            dom.setAttribute('data-title', node.attrs.title || '');
            dom.style.cursor = 'pointer';

            const icon = document.createElement('span');
            icon.className = 'document-link-icon';
            icon.style.display = 'inline-flex';
            icon.style.width = '16px';
            icon.style.height = '16px';
            icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="100%" height="100%"><path stroke="#a1a1a1" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12.5 2h2.7c1.68 0 2.52 0 3.162.327a3 3 0 0 1 1.311 1.311C20 4.28 20 5.12 20 6.8v10.4c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C17.72 22 16.88 22 15.2 22H8.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C4 19.72 4 18.88 4 17.2v-.7M16 13h-4.5M16 9h-3.5m3.5 8H8m-2-7V4.5a1.5 1.5 0 1 1 3 0V10a3 3 0 1 1-6 0V6"/></svg>`;

            const title = document.createElement('span');
            title.className = 'document-link-title';
            title.textContent = node.attrs.title || '';

            dom.appendChild(icon);
            dom.appendChild(title);

            dom.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const targetId = node.attrs.targetId;
                if (targetId) {
                    window.dispatchEvent(new CustomEvent('openDocument', {
                        detail: { id: targetId }
                    }));
                }
            });

            return {
                dom
            };
        };
    },

    addCommands() {
        return {
            setDocumentLink: attributes => ({ commands }) => {
                return commands.insertContent({
                    type: this.name,
                    attrs: attributes
                });
            }
        };
    }
});
