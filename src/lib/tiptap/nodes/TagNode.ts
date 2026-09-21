import { Node, mergeAttributes } from '@tiptap/core';
import { normalizeTagName, TAG_NODE_NAME } from '../tags';

export interface TagOptions {
    HTMLAttributes: Record<string, unknown>;
}

/**
 * A tag, as it sits in a line of writing.
 *
 * An inline atom rather than a mark on text: a chip is one thing, so a
 * backspace should take the whole of it and a click should select the whole of
 * it. A mark would let the user edit the middle of a tag into something the
 * index has never heard of, and there would be no moment at which to
 * renormalise it.
 *
 * The name is stored without its `#`. The hash is presentation, added by the
 * renderer, and storing it too would give every tag two spellings.
 */
export const TagNode = Node.create<TagOptions>({
    name: TAG_NODE_NAME,

    group: 'inline',

    inline: true,

    atom: true,

    addOptions() {
        return {
            HTMLAttributes: {},
        };
    },

    addAttributes() {
        return {
            name: {
                default: null,
                // Normalized on the way in as well as on the way out. This is
                // the door content from a peer, a paste or an older build
                // comes through, and everything downstream (the picker's
                // matching, the index rows) assumes one spelling.
                parseHTML: (element) => normalizeTagName(element.getAttribute('data-name') ?? ''),
                renderHTML: (attributes) => {
                    if (!attributes.name) return {};
                    return { 'data-name': attributes.name };
                },
            },
        };
    },

    parseHTML() {
        return [{ tag: `span[data-type="${TAG_NODE_NAME}"]` }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                'data-type': TAG_NODE_NAME,
                class: 'tag-chip',
            }),
            `#${node.attrs.name ?? ''}`,
        ];
    },

    // What the chip says when the document is read as plain text, which is what
    // a copy out of the editor produces. Without this an atom copies as
    // nothing, and a line pasted elsewhere quietly loses its tags.
    renderText({ node }) {
        return `#${node.attrs.name ?? ''}`;
    },
});
