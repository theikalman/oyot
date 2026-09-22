import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createContentExtensions } from '$lib/editor/extensions';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { serializeDocument, type MarkdownOptions } from './markdown';

const schema = getSchema(createContentExtensions());

function doc(content: unknown[]): ProseMirrorNode {
    return schema.nodeFromJSON({ type: 'doc', content });
}

function para(text: string) {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

const options: MarkdownOptions = {
    attachmentPath: (hash) => `../attachments/${hash}.png`,
    notePath: (id) => (id === 'other' ? 'other-note.md' : null),
};

function render(content: unknown[], overrides: Partial<MarkdownOptions> = {}): string {
    return serializeDocument(doc(content), { ...options, ...overrides });
}

describe('serializeDocument', () => {
    it('writes headings and paragraphs', () => {
        expect(
            render([
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Trip' }] },
                para('two nights in Kyoto'),
            ]),
        ).toBe('## Trip\n\ntwo nights in Kyoto\n');
    });

    it('drops empty paragraphs rather than leaving blank runs', () => {
        expect(render([para('one'), { type: 'paragraph' }, para('two')])).toBe('one\n\ntwo\n');
    });

    it('writes emphasis, keeping the delimiters against the words', () => {
        const marked = (text: string, mark: string) => ({
            type: 'text',
            text,
            marks: [{ type: mark }],
        });
        expect(
            render([
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a ' },
                        marked('bold ', 'bold'),
                        marked('italic', 'italic'),
                        { type: 'text', text: ' and ' },
                        marked('gone', 'strike'),
                    ],
                },
            ]),
        ).toBe('a **bold** *italic* and ~~gone~~\n');
    });

    it('writes a link with its href', () => {
        expect(
            render([
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: 'the docs',
                            marks: [{ type: 'link', attrs: { href: 'https://example.com/a b' } }],
                        },
                    ],
                },
            ]),
        ).toBe('[the docs](https://example.com/a%20b)\n');
    });

    it('writes inline code verbatim, with a fence long enough to hold it', () => {
        expect(
            render([
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'run ' },
                        { type: 'text', text: 'a `b` c', marks: [{ type: 'code' }] },
                    ],
                },
            ]),
        ).toBe('run ``a `b` c``\n');
    });

    it('grows a code fence past a fence inside the block', () => {
        const md = render([
            {
                type: 'codeBlock',
                attrs: { language: 'md' },
                content: [{ type: 'text', text: '```js\nconst a = 1;\n```' }],
            },
        ]);
        expect(md).toBe('````md\n```js\nconst a = 1;\n```\n````\n');
    });

    it('writes bullet and ordered lists, including nesting', () => {
        const md = render([
            {
                type: 'bulletList',
                content: [
                    { type: 'listItem', content: [para('milk')] },
                    {
                        type: 'listItem',
                        content: [
                            para('bread'),
                            {
                                type: 'bulletList',
                                content: [{ type: 'listItem', content: [para('sourdough')] }],
                            },
                        ],
                    },
                ],
            },
        ]);
        expect(md).toBe('-   milk\n-   bread\n\n    -   sourdough\n');
    });

    it('numbers an ordered list from its start attribute', () => {
        const md = render([
            {
                type: 'orderedList',
                attrs: { start: 3 },
                content: [
                    { type: 'listItem', content: [para('third')] },
                    { type: 'listItem', content: [para('fourth')] },
                ],
            },
        ]);
        expect(md).toBe('3.  third\n4.  fourth\n');
    });

    it('writes task items as checkboxes', () => {
        const md = render([
            {
                type: 'taskList',
                content: [
                    { type: 'taskItem', attrs: { checked: true }, content: [para('packed')] },
                    { type: 'taskItem', attrs: { checked: false }, content: [para('booked')] },
                ],
            },
        ]);
        expect(md).toBe('-   [x] packed\n-   [ ] booked\n');
    });

    it('quotes every line of a blockquote', () => {
        const md = render([{ type: 'blockquote', content: [para('first'), para('second')] }]);
        expect(md).toBe('> first\n>\n> second\n');
    });

    it('writes a table with a header row and escapes pipes in cells', () => {
        const cell = (text: string, type = 'tableCell') => ({
            type,
            content: [para(text)],
        });
        const md = render([
            {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [cell('Day', 'tableHeader'), cell('Plan', 'tableHeader')],
                    },
                    { type: 'tableRow', content: [cell('Mon'), cell('a | b')] },
                ],
            },
        ]);
        expect(md).toBe('| Day | Plan |\n| --- | --- |\n| Mon | a \\| b |\n');
    });

    it('links an image to the file the archive will hold', () => {
        const md = render([
            {
                type: 'image',
                attrs: {
                    src: 'oyot-attachment://' + 'a'.repeat(64),
                    alt: 'oyot:' + 'a'.repeat(64),
                },
            },
        ]);
        expect(md).toBe(`![](../attachments/${'a'.repeat(64)}.png)\n`);
    });

    // The bytes live on another device until it connects. A link to a file the
    // archive does not contain would be a broken image with no explanation.
    it('says so when an image is not on this device', () => {
        const hash = 'b'.repeat(64);
        const md = render([{ type: 'image', attrs: { src: `oyot-attachment://${hash}` } }], {
            attachmentPath: () => null,
        });
        expect(md).toBe(`![missing attachment](oyot-attachment://${hash})\n`);
    });

    it('keeps an inline data URI as it is', () => {
        const src = 'data:image/gif;base64,R0lGOD';
        expect(render([{ type: 'image', attrs: { src, alt: 'a dot' } }])).toBe(
            `![a dot](${src})\n`,
        );
    });

    it('writes a tag as its hash form', () => {
        const md = render([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'call mum ' },
                    { type: 'tag', attrs: { name: 'Urgent' } },
                ],
            },
        ]);
        expect(md).toBe('call mum #urgent\n');
    });

    it('links to another note by its file', () => {
        const md = render([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'see ' },
                    { type: 'documentLink', attrs: { targetId: 'other', title: 'Other note' } },
                ],
            },
        ]);
        expect(md).toBe('see [Other note](other-note.md)\n');
    });

    // A link whose target was deleted has no file to point at, and a link to
    // nowhere is worse than the words it was wrapping.
    it('leaves a link to a missing note as plain text', () => {
        const md = render([
            {
                type: 'paragraph',
                content: [{ type: 'documentLink', attrs: { targetId: 'gone', title: 'Gone' } }],
            },
        ]);
        expect(md).toBe('Gone\n');
    });

    it('escapes a paragraph that would otherwise read as a list or a heading', () => {
        expect(
            render([para('- not a bullet'), para('1. not a step'), para('# not a heading')]),
        ).toBe('\\- not a bullet\n\n\\1. not a step\n\n\\# not a heading\n');
    });

    it('escapes characters that would otherwise be markup', () => {
        expect(render([para('a *star* and a [bracket]')])).toBe(
            'a \\*star\\* and a \\[bracket\\]\n',
        );
    });

    // `_` is left alone on purpose: intra-word underscores are not emphasis in
    // CommonMark, and escaping them mangles every identifier in a note.
    it('leaves underscores alone', () => {
        expect(render([para('snake_case_name')])).toBe('snake_case_name\n');
    });

    it('writes a hard break as a line that does not end the paragraph', () => {
        const md = render([
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'one' },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'two' },
                ],
            },
        ]);
        expect(md).toBe('one  \ntwo\n');
    });

    it('writes a horizontal rule', () => {
        expect(render([para('a'), { type: 'horizontalRule' }, para('b')])).toBe('a\n\n---\n\nb\n');
    });

    it('renders nothing for an empty document', () => {
        expect(render([])).toBe('');
    });

    // The export reads documents nobody has opened, straight out of the CRDT,
    // so the round trip is the path that actually runs.
    it('renders a document read back out of the CRDT', () => {
        const ydoc = prosemirrorJSONToYDoc(
            schema,
            {
                type: 'doc',
                content: [
                    {
                        type: 'heading',
                        attrs: { level: 1 },
                        content: [{ type: 'text', text: 'Groceries' }],
                    },
                    {
                        type: 'taskList',
                        content: [
                            {
                                type: 'taskItem',
                                attrs: { checked: false },
                                content: [para('milk')],
                            },
                        ],
                    },
                ],
            },
            'content',
        );
        expect(serializeDocument(rootFromYDoc(ydoc), options)).toBe(
            '# Groceries\n\n-   [ ] milk\n',
        );
    });
});
