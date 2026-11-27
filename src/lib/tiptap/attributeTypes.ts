// What each attribute in the schema may hold, and how a value of the wrong
// type is read.
//
// ProseMirror does not check an attribute's type, and neither does the code
// that reads one: Tiptap's nodes, the table package and the code here all
// take `level` to be a number and `src` to be text. An object where either
// should be made the note throw when it was drawn. By then the value was in
// the Y.Doc, so the note threw again every time it was opened, on every
// device. Two things can put one there: a paste, through the attributes
// ProseMirror keeps in `data-pm-slice`, and a paired device.
//
// So values are fitted to their type at both of those doors, and everything
// past them can go on assuming. A value that already fits is passed on as it
// is, the same array and not a copy of it, so a note holding nothing else is
// stored exactly as before. One that does not fit is read as the nearest
// thing that does, and only in the editor: the stored value stays until that
// node is next edited.
//
// Not `validate` on the attributes, which is the obvious way and loses notes.
// A validator can only throw, and y-tiptap answers a node that throws while
// it is being made by deleting it from the Y.Doc, which syncs.

import { Fragment, Slice } from '@tiptap/pm/model';
import type { Attrs, Mark, MarkType, Node, NodeType, Schema } from '@tiptap/pm/model';
import { numberOf, textOf } from './attrValues';
import { indentStep } from './extensions/Indent';
import { storedAlign } from './imageAttrs';

/**
 * `value` as its attribute may hold it, or undefined for the attribute's own
 * default. Returns `value` itself when it already fits.
 */
type Fit = (value: unknown) => unknown;

/** Text, or null for none. */
const text: Fit = (value) => (value === null ? null : (textOf(value) ?? undefined));

/** A whole number from `min` to `max`. One outside is moved to the nearest end. */
function whole(min: number, max: number): Fit {
    return (value) => {
        const number = numberOf(value);
        if (number === null) return undefined;
        return Math.min(Math.max(Math.trunc(number), min), max);
    };
}

/** Yes or no. The word counts, as it does in the HTML attribute. */
const yesNo: Fit = (value) => value === true || value === 'true';

/** The steps in, or null for none, which is what a block never moved holds. */
const indent: Fit = (value) => (value === null || value === 0 ? value : indentStep(value) || null);

/** A size in pixels, or any other text a page gave, which draws as no size at all. */
const size: Fit = (value) => {
    if (value === null || typeof value === 'string') return value;
    return numberOf(value) ?? undefined;
};

/** A cell's alignment, or null for its column's own. */
const cellAlign: Fit = (value) =>
    value === 'left' || value === 'center' || value === 'right' ? value : null;

/** A width for each column a cell covers, 0 for a column with none set. */
const columnWidths: Fit = (value) => {
    if (!Array.isArray(value)) return null;
    if (value.every((width) => typeof width === 'number' && width >= 0 && width < Infinity)) {
        return value;
    }
    const widths = value.map((width) => Math.max(numberOf(width) ?? 0, 0));
    return widths.some((width) => width > 0) ? widths : null;
};

// As far as HTML takes a cell. Past it, and at 0 or between two whole
// numbers, the table package builds a grid that cannot be drawn, or one with
// no columns, and deletes the table.
const colspan = whole(1, 1000);
const rowspan = whole(1, 65534);

const cell = { colspan, rowspan, colwidth: columnWidths, align: cellAlign };

/**
 * Every attribute in the schema, by the node or mark it is on. The tests hold
 * this to the schema, so an attribute added there has to be added here.
 */
const ATTRIBUTES: Record<string, Record<string, Fit>> = {
    paragraph: { indent },
    heading: { indent, level: whole(1, 6) },
    bulletList: { indent },
    taskList: { indent },
    orderedList: {
        indent,
        start: whole(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
        type: text,
    },
    taskItem: { checked: yesNo },
    codeBlock: { language: text },
    image: {
        src: text,
        alt: text,
        title: text,
        width: size,
        height: size,
        align: storedAlign,
    },
    tableCell: cell,
    tableHeader: cell,
    documentLink: { targetId: text, title: text },
    emailAttachment: { src: text, subject: text, from: text, date: text },
    tag: { name: text },
    unknownBlock: { ref: text, text, found: text },
    unknownInline: { ref: text, text, found: text },
    unknownMark: { name: text, value: text },
    link: { href: text, target: text, rel: text, class: text, title: text },
};

/** Whether `name` on `owner` is an attribute this knows how to fit. */
export function fitsAttribute(owner: string, name: string): boolean {
    return ATTRIBUTES[owner]?.[name] !== undefined;
}

// An attribute from a newer schema than the table above: anything that is
// not a list or an object, which are what throws.
const scalar: Fit = (value) => (value === null || textOf(value) !== null ? value : undefined);

/**
 * `attrs` with every value fitted to its type, or `attrs` itself when they
 * all fit already.
 */
export function fitAttributes(type: NodeType | MarkType, attrs: Attrs | null): Attrs | null {
    const specs = type.spec.attrs;
    if (!attrs || !specs) return attrs;
    const fitted: Record<string, unknown> = {};
    let changed = false;
    for (const name of Object.keys(specs)) {
        const value: unknown = attrs[name];
        // Absent, which ProseMirror reads as the default too.
        if (value === undefined) continue;
        const fit = ATTRIBUTES[type.name]?.[name] ?? scalar;
        const fits = fit(value);
        fitted[name] = fits === undefined ? specs[name].default : fits;
        if (!Object.is(fitted[name], value)) changed = true;
    }
    return changed ? fitted : attrs;
}

function fitMarks(marks: readonly Mark[]): readonly Mark[] {
    let changed = false;
    const fitted = marks.map((mark) => {
        const attrs = fitAttributes(mark.type, mark.attrs);
        if (attrs === mark.attrs) return mark;
        changed = true;
        return mark.type.create(attrs);
    });
    return changed ? fitted : marks;
}

function fitNode(node: Node): Node {
    const marks = fitMarks(node.marks);
    if (node.isText) return marks === node.marks ? node : node.mark(marks);
    const attrs = fitAttributes(node.type, node.attrs);
    const content = fitFragment(node.content);
    if (attrs === node.attrs && content === node.content && marks === node.marks) return node;
    return node.type.create(attrs, content, marks);
}

function fitFragment(fragment: Fragment): Fragment {
    let changed = false;
    const nodes: Node[] = [];
    fragment.forEach((node) => {
        const fitted = fitNode(node);
        if (fitted !== node) changed = true;
        nodes.push(fitted);
    });
    return changed ? Fragment.fromArray(nodes) : fragment;
}

/** What was pasted, with every attribute in it fitted to its type. */
export function fitSlice(slice: Slice): Slice {
    const content = fitFragment(slice.content);
    return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

const tolerant = new WeakSet<Schema>();

/**
 * Make `schema` fit the attributes of every node and mark it is asked for by
 * name, and return it.
 *
 * That is how y-tiptap makes them, in the editor and headless alike, and
 * nothing else in between sees what the Y.Doc holds. The table package reads
 * a cell's attributes straight off the node, so there is no later place to
 * do it.
 */
export function tolerateAttributes(schema: Schema): Schema {
    if (tolerant.has(schema)) return schema;
    tolerant.add(schema);
    const node = schema.node.bind(schema);
    const mark = schema.mark.bind(schema);
    // A name the schema does not have is left for it to refuse.
    schema.node = (type, attrs = null, content, marks) => {
        const of = typeof type === 'string' ? schema.nodes[type] : type;
        return node(type, of ? fitAttributes(of, attrs) : attrs, content, marks);
    };
    schema.mark = (type, attrs = null) => {
        const of = typeof type === 'string' ? schema.marks[type] : type;
        return mark(type, of ? fitAttributes(of, attrs) : attrs);
    };
    return schema;
}
