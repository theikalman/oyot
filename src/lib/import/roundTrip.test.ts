import { describe, it, expect } from 'vitest';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentSchema } from '$lib/editor/headlessIndex';
import { serializeDocument, type MarkdownOptions } from '$lib/export/markdown';
import { readMarkdown, type MarkdownReadOptions } from './markdown';

/**
 * A document written out by the exporter and read back by the importer.
 *
 * The two are written as mirrors of each other, and this is where that is
 * held to: what comes back must be the document that went out, node for node,
 * or a loss listed below on purpose. A change to either side that loses
 * something new fails here, and so does one that fixes a listed loss, so the
 * list stays true.
 *
 * Both sides are set up the way a caller that resolves Oyot's own addresses
 * would set them up: notes and attachments by id and hash rather than by file,
 * every known tag passed in, and a note link's words read back as the title
 * its chip held. The archive passes files instead, and keeps a writer's own
 * words beside the chip; its own tests cover that.
 */

const schema = contentSchema();
const HASH = 'a'.repeat(64);
const NOTES: Record<string, string> = { n1: 'Kyoto trip', n2: 'Renamed since' };
const KNOWN_TAGS = ['house move', 'travel', 'work'];

const writeOptions: MarkdownOptions = {
    attachmentPath: () => null,
    notePath: (id) => (NOTES[id] ? `oyot://note/${id}` : null),
    missingAttachmentAlt: '',
};

const readOptions: MarkdownReadOptions = {
    knownTags: KNOWN_TAGS,
    noteLink: (href) => {
        const id = /^oyot:\/\/note\/(.+)$/.exec(href)?.[1];
        return id && NOTES[id] ? { id, title: NOTES[id] } : null;
    },
    noteLinkLabelIsTitle: true,
};

function doc(content: unknown[]): ProseMirrorNode {
    return schema.nodeFromJSON({ type: 'doc', content });
}

function roundTrip(content: unknown[]): { markdown: string; back: ProseMirrorNode } {
    const markdown = serializeDocument(doc(content), writeOptions);
    return { markdown, back: readMarkdown(markdown, schema, readOptions).doc };
}

const t = (text: string, marks?: unknown[]) =>
    marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: unknown[]) =>
    content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const li = (...content: unknown[]) => ({ type: 'listItem', content });
const task = (checked: boolean, ...content: unknown[]) => ({
    type: 'taskItem',
    attrs: { checked },
    content,
});
const tag = (name: string, marks?: unknown[]) =>
    marks ? { type: 'tag', attrs: { name }, marks } : { type: 'tag', attrs: { name } };
const chip = (targetId: string, title: string, marks?: unknown[]) =>
    marks
        ? { type: 'documentLink', attrs: { targetId, title }, marks }
        : { type: 'documentLink', attrs: { targetId, title } };
const image = (attrs: Record<string, unknown>) => ({
    type: 'image',
    attrs: { src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}`, ...attrs },
});
const cell = (
    type: 'tableCell' | 'tableHeader',
    attrs: Record<string, unknown>,
    ...content: unknown[]
) => ({
    type,
    attrs,
    content: content.length > 0 ? content : [p()],
});
const row = (...cells: unknown[]) => ({ type: 'tableRow', content: cells });
const bold = { type: 'bold' };
const italic = { type: 'italic' };
const underline = { type: 'underline' };
const link = (href: string, title: string | null = null) => ({
    type: 'link',
    attrs: { href, title },
});

/** Documents that come back exactly as they went out. */
const exact: Record<string, unknown[]> = {
    'headings and paragraphs': [
        { type: 'heading', attrs: { level: 2 }, content: [t('Trip')] },
        p(t('two nights')),
    ],
    'bold, italic, strike and code': [
        p(
            t('b', [bold]),
            t(' '),
            t('i', [italic]),
            t(' '),
            t('s', [{ type: 'strike' }]),
            t(' '),
            t('c', [{ type: 'code' }]),
        ),
    ],
    underline: [p(t('a '), t('under', [underline]), t(' b'))],
    'underline inside other marks': [p(t('a '), t('both', [bold, italic, underline]), t(' b'))],
    'a link': [p(t('site', [link('https://x.org')]))],
    'a link with a title': [p(t('site', [link('https://x.org', 'Hover "here"')]))],
    'a hard break in a paragraph': [p(t('a'), { type: 'hardBreak' }, t('b'))],
    'a nested bullet list': [
        {
            type: 'bulletList',
            content: [li(p(t('one')), { type: 'bulletList', content: [li(p(t('two')))] })],
        },
    ],
    'an ordered list that starts at 3': [
        { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('x'))), li(p(t('y')))] },
    ],
    'tasks, ticked and nested': [
        {
            type: 'taskList',
            content: [
                task(true, p(t('done'))),
                task(false, p(t('todo')), {
                    type: 'taskList',
                    content: [task(false, p(t('sub')))],
                }),
            ],
        },
    ],
    'bullets under a task': [
        {
            type: 'taskList',
            content: [task(false, p(t('t')), { type: 'bulletList', content: [li(p(t('note')))] })],
        },
    ],
    'a quote, code with a language, and a rule': [
        { type: 'blockquote', content: [p(t('q'))] },
        { type: 'codeBlock', attrs: { language: 'rust' }, content: [t('fn main() {}')] },
        { type: 'horizontalRule' },
    ],
    // Drawn while reading, so its language is what makes it a diagram.
    'a Mermaid diagram': [
        {
            type: 'codeBlock',
            attrs: { language: 'mermaid' },
            content: [t('flowchart LR\n  a --> b')],
        },
    ],
    'an image with no description': [image({})],
    'an image with a description': [image({ alt: 'A cat' })],
    'tags, one with a space in it': [p(t('pack '), tag('travel'), t(' and '), tag('house move'))],
    'a tag in a heading': [
        { type: 'heading', attrs: { level: 1 }, content: [t('Plan '), tag('work')] },
    ],
    'emphasis around a tag': [p(t('a '), tag('travel', [bold]), t(' b'))],
    'text that looks like markup': [
        p(t('C# and \\#not a tag, *stars*, snake_case, <u>, 1. not a list')),
    ],
    'a note link': [p(t('see '), chip('n1', 'Kyoto trip'))],
    'a note link whose note was renamed since': [p(t('see '), chip('n2', 'Title when linked'))],
    'emphasis around a note link': [p(chip('n1', 'Kyoto trip', [bold]))],
    'a table with a header row': [
        {
            type: 'table',
            content: [
                row(cell('tableHeader', {}, p(t('h1'))), cell('tableHeader', {}, p(t('h2')))),
                row(cell('tableCell', {}, p(t('a'))), cell('tableCell', {}, p(t('b')))),
            ],
        },
    ],
    'a table with aligned columns': [
        {
            type: 'table',
            content: [
                row(
                    cell('tableHeader', { align: 'left' }, p(t('l'))),
                    cell('tableHeader', { align: 'center' }, p(t('c'))),
                    cell('tableHeader', { align: 'right' }, p(t('r'))),
                ),
                row(
                    cell('tableCell', { align: 'left' }, p(t('1'))),
                    cell('tableCell', { align: 'center' }, p(t('2'))),
                    cell('tableCell', { align: 'right' }, p(t('3'))),
                ),
            ],
        },
    ],
};

describe('a round trip through Markdown', () => {
    for (const [name, content] of Object.entries(exact)) {
        it(`keeps ${name}`, () => {
            const { markdown, back } = roundTrip(content);
            expect(back.toJSON(), markdown).toEqual(doc(content).toJSON());
        });
    }
});

/**
 * What Markdown cannot carry, written down. Each is the document that comes
 * back, so a fix shows up as a failure here and the entry can be moved up.
 */
describe('a round trip through Markdown loses, on purpose', () => {
    const losses: Record<string, { from: unknown[]; to: unknown[] }> = {
        // GFM has no table without a header row.
        'a table without a header row, which gains one': {
            from: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableCell', {}, p(t('a')))),
                        row(cell('tableCell', {}, p(t('b')))),
                    ],
                },
            ],
            to: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableHeader', {}, p(t('a')))),
                        row(cell('tableCell', {}, p(t('b')))),
                    ],
                },
            ],
        },
        // A GFM cell is one line.
        'two paragraphs in a cell, which become one': {
            from: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableHeader', {}, p(t('h')))),
                        row(cell('tableCell', {}, p(t('one')), p(t('two')))),
                    ],
                },
            ],
            to: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableHeader', {}, p(t('h')))),
                        row(cell('tableCell', {}, p(t('one two')))),
                    ],
                },
            ],
        },
        // ADR 0021: no width in Markdown, for an image or a column.
        "an image's size": {
            from: [image({ width: 320, height: 200 })],
            to: [image({})],
        },
        'column widths': {
            from: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableHeader', { colwidth: [150] }, p(t('h')))),
                        row(cell('tableCell', {}, p(t('a')))),
                    ],
                },
            ],
            to: [
                {
                    type: 'table',
                    content: [
                        row(cell('tableHeader', {}, p(t('h')))),
                        row(cell('tableCell', {}, p(t('a')))),
                    ],
                },
            ],
        },
        // A heading is one line.
        'a hard break in a heading, which becomes a space': {
            from: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [t('a'), { type: 'hardBreak' }, t('b')],
                },
            ],
            to: [{ type: 'heading', attrs: { level: 1 }, content: [t('a b')] }],
        },
        // The exporter drops them rather than writing runs of blank lines.
        'empty paragraphs between blocks': {
            from: [p(t('a')), p(), p(), p(t('b'))],
            to: [p(t('a')), p(t('b'))],
        },
        // `<u>#name` is not a tag to the importer, so the exporter leaves the
        // underline off rather than lose the tag.
        'underline on a tag': {
            from: [p(t('a '), tag('travel', [underline]), t(' b'))],
            to: [p(t('a '), tag('travel'), t(' b'))],
        },
    };

    for (const [name, { from, to }] of Object.entries(losses)) {
        it(name, () => {
            const { markdown, back } = roundTrip(from);
            expect(back.toJSON(), markdown).toEqual(doc(to).toJSON());
        });
    }
});
