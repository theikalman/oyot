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
                '📄'
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
            icon.textContent = '📄';

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