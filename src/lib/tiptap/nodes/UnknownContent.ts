import { Mark, Node } from '@tiptap/core';
import { UNKNOWN_BLOCK, UNKNOWN_INLINE, UNKNOWN_LABEL, UNKNOWN_MARK } from '../unknownContent';

// Last of everything in the schema, so that nothing about an ordinary note,
// the block a new line is or the order marks nest in, depends on these.
const PRIORITY = 1;

function attributes() {
    return {
        // Which content this stands for. Required, so that ProseMirror never
        // makes one of its own to fill a gap.
        ref: {
            isRequired: true,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-unknown-ref'),
            renderHTML: (attrs: Record<string, unknown>) => ({ 'data-unknown-ref': attrs.ref }),
        },
        text: {
            default: '',
            parseHTML: (element: HTMLElement) => element.textContent ?? '',
            renderHTML: () => ({}),
        },
        // Read by the index, and worked out again wherever one is pasted.
        found: { default: '', parseHTML: () => '', renderHTML: () => ({}) },
    };
}

/**
 * Something among blocks that this build cannot show, with the words in it.
 *
 * An atom: there is nothing in it this build could edit without breaking it.
 * The label is drawn by the stylesheet, so copying the note copies the words
 * and not the label.
 */
export const UnknownBlock = Node.create({
    name: UNKNOWN_BLOCK,
    priority: PRIORITY,
    group: 'block',
    atom: true,
    addAttributes: attributes,

    parseHTML() {
        return [{ tag: 'div[data-unknown-ref]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'div',
            { ...HTMLAttributes, class: 'unknown-content', 'data-label': UNKNOWN_LABEL },
            ['div', { class: 'unknown-content-words' }, String(node.attrs.text ?? '')],
        ];
    },

    renderText({ node }) {
        return String(node.attrs.text ?? '');
    },
});

/** Something in a line of writing that this build cannot show. */
export const UnknownInline = Node.create({
    name: UNKNOWN_INLINE,
    priority: PRIORITY,
    group: 'inline',
    inline: true,
    atom: true,
    addAttributes: attributes,

    parseHTML() {
        return [{ tag: 'span[data-unknown-ref]' }];
    },

    renderHTML({ node, HTMLAttributes }) {
        return [
            'span',
            { ...HTMLAttributes, class: 'unknown-inline', title: UNKNOWN_LABEL },
            String(node.attrs.text ?? ''),
        ];
    },

    renderText({ node }) {
        return String(node.attrs.text ?? '');
    },
});

/**
 * Formatting this build does not know, on words it does.
 *
 * A mark rather than a placeholder, so the words stay words and can be edited.
 * Any number can be on one word, each by the name it is stored under, and
 * `value` is what is stored, as JSON. Not inclusive: typing after it does not
 * carry on formatting that cannot be seen or turned off here.
 */
export const UnknownMark = Mark.create({
    name: UNKNOWN_MARK,
    priority: PRIORITY,
    excludes: '',
    inclusive: false,

    addAttributes() {
        return {
            name: {
                default: '',
                parseHTML: (element) => element.getAttribute('data-unknown-mark'),
                renderHTML: (attrs) => ({ 'data-unknown-mark': attrs.name }),
            },
            value: {
                default: '',
                parseHTML: (element) => element.getAttribute('data-unknown-value'),
                renderHTML: (attrs) => ({ 'data-unknown-value': attrs.value }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-unknown-mark]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', HTMLAttributes, 0];
    },
});
