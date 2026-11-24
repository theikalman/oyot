import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { MarkType, NodeType } from '@tiptap/pm/model';
import { createContentExtensions } from '$lib/editor/extensions';
import { fitAttributes, fitSlice, fitsAttribute, tolerateAttributes } from './attributeTypes';

// The editor's real schema, so every attribute in a note is here.
const schema = getSchema(createContentExtensions());

const typeNamed = (name: string): NodeType | MarkType => schema.nodes[name] ?? schema.marks[name];

// Less what stands for unknown content, which is never stored, and is made
// again from what is in the note wherever it is pasted (ADR 0044).
const every = [...Object.values(schema.nodes), ...Object.values(schema.marks)]
    .filter((type) => !type.name.startsWith('unknown'))
    .flatMap((type) =>
        Object.keys(type.spec.attrs ?? {}).map((name) => ({ owner: type.name, name })),
    );

/** What `value` on an attribute is read as. */
function read(owner: string, name: string, value: unknown): unknown {
    return fitAttributes(typeNamed(owner), { [name]: value })![name];
}

// One of each kind of wrong value. The second object is the one that throws
// when it is turned into a string, the first is the one that does not.
const array = [1, { a: 1 }];
const object = { a: 1 };
const ownString = { toString: 'x' };

/** What an array, an object of either kind, 7 and true are each read as. */
type Readings = [array: unknown, object: unknown, number: unknown, boolean: unknown];

const asText = (none: unknown = null): Readings => [none, none, '7', 'true'];
const asIndent: Readings = [null, null, 7, null];
const asSize: Readings = [null, null, 7, null];
const asSpan: Readings = [1, 1, 7, 1];
const asAlign: Readings = [null, null, null, null];
const asCell = {
    colspan: asSpan,
    rowspan: asSpan,
    // The width that is one is kept, and the rest are columns with none set.
    colwidth: [[1, 0], null, null, null] satisfies Readings,
    align: asAlign,
};

const READ_AS: Record<string, Record<string, Readings>> = {
    paragraph: { indent: asIndent },
    heading: { indent: asIndent, level: [1, 1, 6, 1] },
    bulletList: { indent: asIndent },
    taskList: { indent: asIndent },
    orderedList: { indent: asIndent, start: [1, 1, 7, 1], type: asText() },
    taskItem: { checked: [false, false, false, true] },
    codeBlock: { language: asText() },
    image: {
        src: asText(),
        alt: asText(),
        title: asText(),
        width: asSize,
        height: asSize,
        align: asAlign,
    },
    tableCell: asCell,
    tableHeader: asCell,
    documentLink: { targetId: asText(), title: asText() },
    tag: { name: asText() },
    link: {
        href: asText(),
        target: asText('_blank'),
        rel: asText('noopener noreferrer nofollow'),
        class: asText(),
        title: asText(),
    },
};

describe('the schema', () => {
    it('has every attribute fitted, and none that has no default to fall back on', () => {
        for (const { owner, name } of every) {
            expect(fitsAttribute(owner, name), `${owner}.${name}`).toBe(true);
            expect(typeNamed(owner).spec.attrs![name], `${owner}.${name}`).toHaveProperty(
                'default',
            );
        }
    });

    it('has no attribute that is validated, which would delete what it refuses', () => {
        for (const { owner, name } of every) {
            expect(typeNamed(owner).spec.attrs![name].validate, `${owner}.${name}`).toBe(undefined);
        }
    });

    it('has every attribute in the tests below', () => {
        const tested = Object.entries(READ_AS).flatMap(([owner, names]) =>
            Object.keys(names).map((name) => `${owner}.${name}`),
        );
        expect(tested.sort()).toEqual(every.map(({ owner, name }) => `${owner}.${name}`).sort());
    });
});

describe.each(every)('$owner.$name', ({ owner, name }) => {
    const [fromArray, fromObject, fromNumber, fromBoolean] = READ_AS[owner][name];

    it('reads an array', () => {
        expect(read(owner, name, array)).toEqual(fromArray);
    });

    it('reads an object', () => {
        expect(read(owner, name, object)).toEqual(fromObject);
    });

    it('reads an object with a toString of its own', () => {
        expect(read(owner, name, ownString)).toEqual(fromObject);
    });

    it('reads a number', () => {
        expect(read(owner, name, 7)).toEqual(fromNumber);
    });

    it('reads a boolean', () => {
        expect(read(owner, name, true)).toEqual(fromBoolean);
    });

    it('reads what only Yjs can hold', () => {
        const shared = new Y.Doc().getMap('root').set('map', new Y.Map());
        for (const value of [shared, new Uint8Array([1]), Object.create(null)]) {
            expect(read(owner, name, value)).toEqual(fromObject);
        }
        // A bigint is a number to an attribute that is one.
        expect(typeof read(owner, name, 10n)).not.toBe('bigint');
    });

    it('keeps its own default', () => {
        const value: unknown = typeNamed(owner).spec.attrs![name].default;
        const attrs = { [name]: value };
        expect(fitAttributes(typeNamed(owner), attrs)).toBe(attrs);
    });

    it('is the same read twice', () => {
        for (const value of [array, object, ownString, 7, true, 10n, 'x', '3', -1, 2.5, NaN]) {
            const once = read(owner, name, value);
            expect(read(owner, name, once)).toBe(once);
        }
    });
});

describe('fitAttributes', () => {
    it('passes on what fits as it is, not a copy of it', () => {
        const fitting: [owner: string, attrs: Record<string, unknown>][] = [
            ['paragraph', { indent: 3 }],
            ['heading', { indent: null, level: 2 }],
            ['orderedList', { indent: null, start: 0, type: 'a' }],
            ['taskItem', { checked: true }],
            ['codeBlock', { language: 'ts' }],
            [
                'image',
                {
                    src: 'oyot-attachment://ab',
                    alt: '',
                    title: null,
                    width: 300,
                    height: 200.5,
                    align: 'center',
                },
            ],
            // A size a page gave that is not in pixels, which has always
            // been stored as it came and drawn as none.
            ['image', { width: '50%', height: 'auto' }],
            ['tableCell', { colspan: 2, rowspan: 3, colwidth: [100, 0], align: 'right' }],
            ['documentLink', { targetId: 'id', title: 'Title' }],
            ['tag', { name: 'work' }],
            ['link', { href: 'https://a.example', target: null, rel: null, class: 'c' }],
        ];
        for (const [owner, attrs] of fitting) {
            expect(fitAttributes(typeNamed(owner), attrs), owner).toBe(attrs);
        }
    });

    it('keeps the array of widths itself, which Yjs compares by identity', () => {
        const colwidth = [100, 0];
        const fitted = fitAttributes(schema.nodes.tableCell, { colspan: {}, colwidth });
        expect(fitted!.colwidth).toBe(colwidth);
    });

    it('keeps every other value beside one that does not fit', () => {
        expect(fitAttributes(schema.nodes.image, { src: 'a', alt: ownString, width: 300 })).toEqual(
            { src: 'a', alt: null, width: 300 },
        );
    });

    it('reads a span the table package cannot lay out as the nearest it can', () => {
        for (const [value, span] of [
            [0, 1],
            [-3, 1],
            [2.5, 2],
            [NaN, 1],
            [Infinity, 1],
            ['2', 2],
            [1e9, 1000],
        ]) {
            expect(read('tableCell', 'colspan', value)).toBe(span);
        }
        expect(read('tableCell', 'rowspan', 1e9)).toBe(65534);
    });

    it('reads a column width that is not one as a column with none set', () => {
        expect(read('tableCell', 'colwidth', ['100', null, -5])).toEqual([100, 0, 0]);
        expect(read('tableCell', 'colwidth', [NaN])).toBeNull();
        expect(read('tableCell', 'colwidth', [ownString, [1]])).toBeNull();
    });

    it('takes whatever a mark was formatted with', () => {
        for (const attrs of [true, 'x', 7, [], null]) {
            expect(() => fitAttributes(schema.marks.link, attrs as never)).not.toThrow();
        }
    });
});

describe('fitSlice', () => {
    const { nodes, marks } = schema;

    it('passes on a slice with nothing to fit as it is', () => {
        const slice = new Slice(
            Fragment.from(nodes.paragraph.create({ indent: 2 }, schema.text('words'))),
            1,
            1,
        );
        expect(fitSlice(slice)).toBe(slice);
    });

    it('fits a node however deep, and the marks on it and on its text', () => {
        const bad = marks.link.create({ href: ownString });
        const slice = new Slice(
            Fragment.from([
                nodes.paragraph.create(null, schema.text('before')),
                nodes.blockquote.create(null, [
                    nodes.heading.create({ level: ownString, indent: [1] }, [
                        schema.text('words', [bad]),
                        nodes.tag.create({ name: object }, null, [bad]),
                    ]),
                ]),
            ]),
            0,
            2,
        );

        const fitted = fitSlice(slice);

        expect([fitted.openStart, fitted.openEnd]).toEqual([0, 2]);
        expect(fitted.content.firstChild).toBe(slice.content.firstChild);
        const heading = fitted.content.lastChild!.firstChild!;
        expect(heading.attrs).toEqual({ level: 1, indent: null });
        expect(heading.textContent).toBe('words');
        heading.forEach((child) => expect(child.marks[0].attrs.href).toBeNull());
        expect(heading.lastChild!.attrs.name).toBeNull();
    });
});

describe('tolerateAttributes', () => {
    const tolerant = tolerateAttributes(getSchema(createContentExtensions()));

    it('fits the nodes and marks asked for by name or by type', () => {
        const { heading } = tolerant.nodes;
        const { link } = tolerant.marks;
        expect(tolerant.node('heading', { level: ownString }).attrs.level).toBe(1);
        expect(tolerant.node(heading, { level: ownString }).attrs.level).toBe(1);
        expect(tolerant.mark('link', { href: ownString }).attrs.href).toBeNull();
        expect(tolerant.mark(link, { href: ownString }).attrs.href).toBeNull();
    });

    it('leaves the schema to refuse what it does not have', () => {
        expect(() => tolerant.node('nothing', {})).toThrow(/Unknown node type/);
        expect(() => tolerant.mark('nothing', {})).toThrow();
        expect(() => tolerant.node('tableCell', { colspan: object }, [])).toThrow(/content/);
    });

    it('is done once', () => {
        const { node, mark } = tolerant;
        expect(tolerateAttributes(tolerant)).toBe(tolerant);
        expect(tolerant.node).toBe(node);
        expect(tolerant.mark).toBe(mark);
    });
});
