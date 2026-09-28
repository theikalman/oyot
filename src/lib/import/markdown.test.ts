import { describe, it, expect } from 'vitest';
import { contentSchema } from '$lib/editor/headlessIndex';
import { serializeDocument, type MarkdownOptions } from '$lib/export/markdown';
import { leadingHeading, readMarkdown, storedImage, type MarkdownReadOptions } from './markdown';

const schema = contentSchema();
const HASH = 'a'.repeat(64);

function read(markdown: string, options: MarkdownReadOptions = {}) {
    return readMarkdown(markdown, schema, options).doc.toJSON().content;
}

const text = (value: string, marks?: unknown[]) =>
    marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const para = (...content: unknown[]) =>
    content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const tag = (name: string) => ({ type: 'tag', attrs: { name } });
const bold = { type: 'bold' };
const code = { type: 'code' };
const link = (href: string, title: string | null = null) => ({
    type: 'link',
    attrs: expect.objectContaining({ href, title }),
});

describe('readMarkdown: blocks', () => {
    it('reads headings and paragraphs', () => {
        expect(read('## Trip\n\ntwo nights in Kyoto')).toEqual([
            { type: 'heading', attrs: { level: 2 }, content: [text('Trip')] },
            para(text('two nights in Kyoto')),
        ]);
    });

    it('reads a setext heading as a heading', () => {
        expect(read('Trip\n----')).toEqual([
            { type: 'heading', attrs: { level: 2 }, content: [text('Trip')] },
        ]);
    });

    it('gives an empty file one empty paragraph, as the editor has', () => {
        expect(read('')).toEqual([para()]);
        expect(read('\n\n  \n')).toEqual([para()]);
    });

    it('reads a quote, with the paragraphs inside it', () => {
        expect(read('> first\n>\n> second')).toEqual([
            { type: 'blockquote', content: [para(text('first')), para(text('second'))] },
        ]);
    });

    it('reads a fenced code block with its language, verbatim', () => {
        expect(read('```js\nconst a = `b`;\n  *not emphasis*\n```')).toEqual([
            {
                type: 'codeBlock',
                attrs: { language: 'js' },
                content: [text('const a = `b`;\n  *not emphasis*')],
            },
        ]);
    });

    it('reads an indented code block, which has no language', () => {
        expect(read('    indented')).toEqual([
            { type: 'codeBlock', attrs: { language: null }, content: [text('indented')] },
        ]);
    });

    it('keeps an empty code block', () => {
        expect(read('```\n```')).toEqual([{ type: 'codeBlock', attrs: { language: null } }]);
    });

    it('reads a horizontal rule', () => {
        expect(read('a\n\n---\n\nb')).toEqual([
            para(text('a')),
            { type: 'horizontalRule' },
            para(text('b')),
        ]);
    });

    it('reads a line break that ends a line, and joins lines that merely wrap', () => {
        expect(read('one  \ntwo\nthree')).toEqual([
            para(text('one'), { type: 'hardBreak' }, text('two three')),
        ]);
    });
});

describe('readMarkdown: lists', () => {
    it('reads bullet lists, nesting included', () => {
        expect(read('- milk\n- bread\n    - sourdough')).toEqual([
            {
                type: 'bulletList',
                content: [
                    { type: 'listItem', content: [para(text('milk'))] },
                    {
                        type: 'listItem',
                        content: [
                            para(text('bread')),
                            {
                                type: 'bulletList',
                                content: [{ type: 'listItem', content: [para(text('sourdough'))] }],
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it('numbers an ordered list from where the file starts it', () => {
        expect(read('3. third\n4. fourth')).toEqual([
            {
                type: 'orderedList',
                attrs: expect.objectContaining({ start: 3 }),
                content: [
                    { type: 'listItem', content: [para(text('third'))] },
                    { type: 'listItem', content: [para(text('fourth'))] },
                ],
            },
        ]);
    });

    it('reads task items as tasks, ticked or not', () => {
        expect(read('- [x] packed\n- [ ] booked\n- [X] **paid**')).toEqual([
            {
                type: 'taskList',
                content: [
                    { type: 'taskItem', attrs: { checked: true }, content: [para(text('packed'))] },
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [para(text('booked'))],
                    },
                    {
                        type: 'taskItem',
                        attrs: { checked: true },
                        content: [para(text('paid', [bold]))],
                    },
                ],
            },
        ]);
    });

    it('needs a space after the box before an item is a task', () => {
        expect(read('- [x]not a task')).toEqual([
            {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [para(text('[x]not a task'))] }],
            },
        ]);
    });

    // A task list holds only tasks, so a list that mixes them becomes one
    // list per stretch, in the order the items came.
    it('splits a list that mixes tasks with plain items', () => {
        const kinds = read('- [ ] call\n- note\n- [x] done').map(
            (block: { type: string }) => block.type,
        );
        expect(kinds).toEqual(['taskList', 'bulletList', 'taskList']);
    });

    it('keeps counting when an ordered list is split around a task', () => {
        const blocks = read('1. one\n2. [ ] two\n3. three');
        expect(blocks.map((block: { type: string }) => block.type)).toEqual([
            'orderedList',
            'taskList',
            'orderedList',
        ]);
        expect(blocks[2].attrs.start).toBe(3);
    });

    it('gives an empty item, or one that opens with a block, a paragraph first', () => {
        expect(read('-\n- ```\n  code\n  ```')).toEqual([
            {
                type: 'bulletList',
                content: [
                    { type: 'listItem', content: [para()] },
                    {
                        type: 'listItem',
                        content: [
                            para(),
                            {
                                type: 'codeBlock',
                                attrs: { language: null },
                                content: [text('code')],
                            },
                        ],
                    },
                ],
            },
        ]);
    });
});

describe('readMarkdown: inline', () => {
    it('reads emphasis, strikethrough and inline code', () => {
        expect(read('a **b** *i* ~~s~~ `c`')).toEqual([
            para(
                text('a '),
                text('b', [bold]),
                text(' '),
                text('i', [{ type: 'italic' }]),
                text(' '),
                text('s', [{ type: 'strike' }]),
                text(' '),
                text('c', [code]),
            ),
        ]);
    });

    // The schema lets code carry no other mark.
    it('lets code take over the marks around it', () => {
        expect(read('**`x`**')).toEqual([para(text('x', [code]))]);
    });

    // Except a link's: the address is worth more than the typeface.
    it('keeps the link when code is inside one', () => {
        expect(read('[`x`](https://example.com)')).toEqual([
            para(text('x', [link('https://example.com')])),
        ]);
    });

    it('reads a link with its address and title', () => {
        expect(read('[the docs](https://example.com/a%20b "Docs")')).toEqual([
            para(text('the docs', [link('https://example.com/a%20b', 'Docs')])),
        ]);
    });

    it('links a bare web address and an email address, as GitHub does', () => {
        expect(read('see https://example.com or a@b.com')).toEqual([
            para(
                text('see '),
                text('https://example.com', [link('https://example.com')]),
                text(' or '),
                text('a@b.com', [link('mailto:a@b.com')]),
            ),
        ]);
    });

    // `.md` is a country's domain.
    it('does not take a file name for a web address', () => {
        expect(read('see notes.md')).toEqual([para(text('see notes.md'))]);
    });

    it('leaves a script address as the text it is', () => {
        expect(read('[click](javascript:alert(1))')).toEqual([
            para(text('[click](javascript:alert(1))')),
        ]);
    });

    it('decodes entities and escapes', () => {
        expect(read('a &amp; b \\*not\\*')).toEqual([para(text('a & b *not*'))]);
    });
});

describe('readMarkdown: tags', () => {
    it('reads #name as a tag, in the one spelling tags have', () => {
        expect(read('call mum #Urgent')).toEqual([para(text('call mum '), tag('urgent'))]);
    });

    it('ends a tag at punctuation', () => {
        expect(read('#urgent, #home.')).toEqual([
            para(tag('urgent'), text(', '), tag('home'), text('.')),
        ]);
    });

    it('allows the characters Obsidian and Bear allow', () => {
        expect(read('#work/q3-plan #café #日記')).toEqual([
            para(tag('work/q3-plan'), text(' '), tag('café'), text(' '), tag('日記')),
        ]);
    });

    it('reads a tag that starts a line inside a paragraph', () => {
        expect(read('first line\n#later')).toEqual([para(text('first line '), tag('later'))]);
    });

    it('leaves a # that does not begin a word', () => {
        expect(read('C# and page/#anchor and ##double')).toEqual([
            para(text('C# and page/#anchor and ##double')),
        ]);
    });

    it('leaves a number as a number', () => {
        expect(read('issue #42 is #1')).toEqual([para(text('issue #42 is #1'))]);
    });

    it('leaves an escaped hash, code, and a heading alone', () => {
        expect(read('\\#not `#code`')).toEqual([para(text('#not '), text('#code', [code]))]);
        expect(read('# Heading')).toEqual([
            { type: 'heading', attrs: { level: 1 }, content: [text('Heading')] },
        ]);
    });

    it('leaves a # inside a link as part of the link', () => {
        expect(read('[see #this](https://example.com)')).toEqual([
            para(text('see #this', [link('https://example.com')])),
        ]);
    });

    it('keeps a tag inside emphasis, with the emphasis', () => {
        expect(read('**#urgent**')).toEqual([para({ ...tag('urgent'), marks: [bold] })]);
    });

    it('reads a tag inside brackets', () => {
        expect(read('(#home)')).toEqual([para(text('('), tag('home'), text(')'))]);
    });

    // The exporter writes a tag with a space in it the only way it can, and
    // lists it in the front matter; that list is what tells it apart.
    it('reads a tag with a space in it when it is known', () => {
        expect(read('pack for the #house move today', { knownTags: ['house move'] })).toEqual([
            para(text('pack for the '), tag('house move'), text(' today')),
        ]);
        expect(read('pack for the #house move today')).toEqual([
            para(text('pack for the '), tag('house'), text(' move today')),
        ]);
    });

    it('prefers the longer known tag, and only where it ends', () => {
        const knownTags = ['house', 'house move'];
        expect(read('#house move', { knownTags })).toEqual([para(tag('house move'))]);
        expect(read('#house movers', { knownTags })).toEqual([para(tag('house'), text(' movers'))]);
    });
});

describe('readMarkdown: links between notes', () => {
    const notes: Record<string, { id: string; title: string }> = {
        'other-note.md': { id: 'other', title: 'Other note' },
        'café notes.md': { id: 'cafe', title: 'Café notes' },
    };
    const noteLink = (href: string) => notes[decodeURIComponent(href.split('#')[0])] ?? null;

    it('reads a link to a note being imported as a link to that note', () => {
        expect(read('see [the other one](other-note.md)', { noteLink })).toEqual([
            para(text('see '), {
                type: 'documentLink',
                attrs: { targetId: 'other', title: 'Other note' },
            }),
        ]);
    });

    it('asks about the address as markdown-it normalized it', () => {
        expect(read('[x](<café notes.md>) [y](other-note.md#part)', { noteLink })).toEqual([
            para(
                { type: 'documentLink', attrs: { targetId: 'cafe', title: 'Café notes' } },
                text(' '),
                { type: 'documentLink', attrs: { targetId: 'other', title: 'Other note' } },
            ),
        ]);
    });

    it('leaves a link to anything else a link', () => {
        expect(read('[gone](gone.md)', { noteLink })).toEqual([
            para(text('gone', [link('gone.md')])),
        ]);
    });
});

describe('readMarkdown: images', () => {
    const count = (markdown: string) => readMarkdown(markdown, schema).imagesKeptAsText;

    it('stores an image the exporter wrote as the attachment it names', () => {
        expect(read(`![](../attachments/${HASH}.png)`)).toEqual([
            {
                type: 'image',
                attrs: expect.objectContaining({
                    src: `oyot-attachment://${HASH}`,
                    alt: `oyot:${HASH}`,
                }),
            },
        ]);
    });

    it('keeps a description as the alt text', () => {
        expect(read(`![the view](oyot-attachment://${HASH} "Kyoto")`)).toEqual([
            {
                type: 'image',
                attrs: expect.objectContaining({
                    src: `oyot-attachment://${HASH}`,
                    alt: 'the view',
                    title: 'Kyoto',
                }),
            },
        ]);
    });

    it('keeps an inline raster image as it is', () => {
        const src = 'data:image/png;base64,iVBORw0KGgo=';
        expect(read(`![a dot](${src})`)).toEqual([
            { type: 'image', attrs: expect.objectContaining({ src, alt: 'a dot' }) },
        ]);
    });

    // A file beside the note is not read, and a web address is not loaded:
    // what was written stays, where it was, as text.
    it('keeps an image there is nothing to show for as its Markdown', () => {
        expect(read('before ![a map](maps/kyoto.png) after')).toEqual([
            para(text('before ![a map](maps/kyoto.png) after')),
        ]);
        expect(read('![](https://example.com/a.png "Title")')).toEqual([
            para(text('![](https://example.com/a.png "Title")')),
        ]);
        expect(count('![a](a.png) ![b](https://example.com/b.png)')).toBe(2);
        expect(count(`![](oyot-attachment://${HASH})`)).toBe(0);
    });

    it('splits a line around an image, since an image is a block of its own', () => {
        expect(read(`before ![](oyot-attachment://${HASH}) after`)).toEqual([
            para(text('before')),
            { type: 'image', attrs: expect.objectContaining({ src: `oyot-attachment://${HASH}` }) },
            para(text('after')),
        ]);
    });

    it('puts a paragraph before an image that opens a list item', () => {
        expect(read(`- ![](oyot-attachment://${HASH}) caption`)).toEqual([
            {
                type: 'bulletList',
                content: [
                    {
                        type: 'listItem',
                        content: [
                            para(),
                            {
                                type: 'image',
                                attrs: expect.objectContaining({ alt: `oyot:${HASH}` }),
                            },
                            para(text('caption')),
                        ],
                    },
                ],
            },
        ]);
    });

    it('decides by the address, with the alt as the older way of naming one', () => {
        expect(storedImage('maps/kyoto.png', '')).toBeNull();
        expect(storedImage('https://example.com/a.png', '')).toBeNull();
        expect(storedImage('data:image/svg+xml;base64,PHN2Zz4=', '')).toBeNull();
        expect(storedImage('anything.png', `oyot:${HASH}`)).toEqual({
            src: `oyot-attachment://${HASH}`,
            alt: `oyot:${HASH}`,
        });
    });
});

describe('readMarkdown: tables and HTML', () => {
    it('reads a table, its header row and its alignment', () => {
        expect(read('| Day | Plan |\n| :-: | --- |\n| Mon | rest |')).toEqual([
            {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [
                            {
                                type: 'tableHeader',
                                attrs: expect.objectContaining({ align: 'center' }),
                                content: [para(text('Day'))],
                            },
                            {
                                type: 'tableHeader',
                                attrs: expect.objectContaining({ align: null }),
                                content: [para(text('Plan'))],
                            },
                        ],
                    },
                    {
                        type: 'tableRow',
                        content: [
                            {
                                type: 'tableCell',
                                attrs: expect.objectContaining({ align: 'center' }),
                                content: [para(text('Mon'))],
                            },
                            {
                                type: 'tableCell',
                                attrs: expect.objectContaining({ align: null }),
                                content: [para(text('rest'))],
                            },
                        ],
                    },
                ],
            },
        ]);
    });

    it('fills out a short row, and reads a <br> in a cell as a line break', () => {
        const [table] = read('| a | b |\n| - | - |\n| x<br>y |');
        const [, row] = table.content;
        expect(row.content).toHaveLength(2);
        expect(row.content[0].content).toEqual([para(text('x'), { type: 'hardBreak' }, text('y'))]);
        expect(row.content[1].content).toEqual([para()]);
    });

    it('keeps inline HTML as the text it is', () => {
        expect(read('a <u>b</u> <!-- note -->')).toEqual([para(text('a <u>b</u> <!-- note -->'))]);
    });

    it('keeps a block of HTML as text, a line for a line', () => {
        expect(read('<aside>\n💡 water the plants\n</aside>')).toEqual([
            para(
                text('<aside>'),
                { type: 'hardBreak' },
                text('💡 water the plants'),
                { type: 'hardBreak' },
                text('</aside>'),
            ),
        ]);
    });
});

describe('leadingHeading', () => {
    it('finds a top-level heading that opens the file, and the lines it spans', () => {
        expect(leadingHeading('# Groceries\n\nmilk')).toEqual({ text: 'Groceries', lines: [0, 1] });
        expect(leadingHeading('Groceries\n=========\n\nmilk')).toEqual({
            text: 'Groceries',
            lines: [0, 2],
        });
        expect(leadingHeading('\n\n# Late start')).toEqual({ text: 'Late start', lines: [2, 3] });
    });

    it('reads the heading as plain words', () => {
        expect(leadingHeading('# Trip to *Kyoto* `2026` #travel')?.text).toBe(
            'Trip to Kyoto 2026 #travel',
        );
    });

    it('finds nothing when the file opens with anything else', () => {
        expect(leadingHeading('## Subheading')).toBeNull();
        expect(leadingHeading('intro\n\n# Heading')).toBeNull();
        expect(leadingHeading('')).toBeNull();
    });
});

// The exporter and this are two halves of one format. A note taken out and
// brought back must come back as it was.
describe('the round trip through the exporter', () => {
    const exportOptions: MarkdownOptions = {
        attachmentPath: (hash) => `../attachments/${hash}.png`,
        notePath: (id) => (id === 'other' ? 'other-note.md' : null),
    };
    const importOptions: MarkdownReadOptions = {
        noteLink: (href) =>
            href === 'other-note.md' ? { id: 'other', title: 'Other note' } : null,
        knownTags: ['house move'],
    };

    const original = schema.nodeFromJSON({
        type: 'doc',
        content: [
            { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
            para(
                text('Pack '),
                text('light', [bold]),
                text(', see '),
                { type: 'documentLink', attrs: { targetId: 'other', title: 'Other note' } },
                text(' and '),
                text('the map', [{ type: 'link', attrs: { href: 'https://example.com/map' } }]),
                text(' '),
                tag('travel'),
                text(' '),
                tag('house move'),
            ),
            para(text('a [bracket] and *stars* and 1. not a list')),
            {
                type: 'taskList',
                content: [
                    {
                        type: 'taskItem',
                        attrs: { checked: true },
                        content: [para(text('passport'))],
                    },
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [
                            para(text('tickets')),
                            {
                                type: 'bulletList',
                                content: [{ type: 'listItem', content: [para(text('train'))] }],
                            },
                        ],
                    },
                ],
            },
            {
                type: 'orderedList',
                attrs: { start: 3 },
                content: [{ type: 'listItem', content: [para(text('third'))] }],
            },
            { type: 'blockquote', content: [para(text('first')), para(text('second'))] },
            {
                type: 'codeBlock',
                attrs: { language: 'md' },
                content: [text('```js\nconst a = 1;\n```')],
            },
            { type: 'image', attrs: { src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}` } },
            { type: 'horizontalRule' },
            {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [
                            { type: 'tableHeader', content: [para(text('Day'))] },
                            { type: 'tableHeader', content: [para(text('Plan'))] },
                        ],
                    },
                    {
                        type: 'tableRow',
                        content: [
                            { type: 'tableCell', content: [para(text('Mon'))] },
                            { type: 'tableCell', content: [para(text('a | b'))] },
                        ],
                    },
                ],
            },
            para(text('one'), { type: 'hardBreak' }, text('two')),
        ],
    });

    it('brings back the document the exporter was given', () => {
        const markdown = serializeDocument(original, exportOptions);
        const { doc, imagesKeptAsText } = readMarkdown(markdown, schema, importOptions);
        expect(imagesKeptAsText).toBe(0);
        expect(doc.toJSON()).toEqual(original.toJSON());
    });

    it('exports what it imported as the same Markdown', () => {
        const markdown = serializeDocument(original, exportOptions);
        const { doc } = readMarkdown(markdown, schema, importOptions);
        expect(serializeDocument(doc, exportOptions)).toBe(markdown);
    });

    // Words that look like Markdown, which the exporter has to escape for
    // them to come back as the words they are.
    it('brings back words that look like Markdown as words', () => {
        const hardBreakThen = (line: string) =>
            para(text('buy'), { type: 'hardBreak' }, text(line));
        const words = schema.nodeFromJSON({
            type: 'doc',
            content: [
                para(text('1. not a step')),
                para(text('## not a heading')),
                para(text('---')),
                para(text('    four leading spaces')),
                para(text('paint it #ff0000, reply to (#support), in C#')),
                para(text('call __init__ with _care_ and ~~this~~, AT&amp;T')),
                {
                    type: 'taskList',
                    content: [
                        {
                            type: 'taskItem',
                            attrs: { checked: false },
                            content: [hardBreakThen('- milk')],
                        },
                        {
                            type: 'taskItem',
                            attrs: { checked: true },
                            content: [hardBreakThen('===')],
                        },
                        {
                            type: 'taskItem',
                            attrs: { checked: false },
                            content: [
                                para(),
                                {
                                    type: 'taskList',
                                    content: [
                                        {
                                            type: 'taskItem',
                                            attrs: { checked: true },
                                            content: [para(text('subtask'))],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                { type: 'heading', attrs: { level: 2 }, content: [text('Issue #')] },
            ],
        });
        const markdown = serializeDocument(words, exportOptions);
        const { doc } = readMarkdown(markdown, schema, importOptions);
        expect(doc.toJSON()).toEqual(words.toJSON());
    });
});
