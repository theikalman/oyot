import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { createContentExtensions } from '$lib/editor/extensions';
import {
    MAX_INDENT,
    atIndentableStart,
    inIndentableList,
    inNestedItem,
    indentOf,
    shiftIndent,
} from './Indent';

// The editor's real schema, so the attribute is tested on the nodes that
// carry it in a note.
const schema = getSchema(createContentExtensions());

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string, indent?: number) => ({
    type: 'paragraph',
    ...(indent ? { attrs: { indent } } : {}),
    content: [text(value)],
});
const heading = (value: string) => ({
    type: 'heading',
    attrs: { level: 2 },
    content: [text(value)],
});
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

// Where `needle` starts in `source`, as a document position.
function positionOf(source: Node, needle: string): number {
    let found = -1;
    source.descendants((node, pos) => {
        if (found >= 0) return false;
        const at = node.isText ? node.text!.indexOf(needle) : -1;
        if (at >= 0) found = pos + at;
    });
    if (found < 0) throw new Error(`"${needle}" is not in the document`);
    return found;
}

function caretAt(source: Node, needle: string, offset = 0): EditorState {
    const selection = TextSelection.create(source, positionOf(source, needle) + offset);
    return EditorState.create({ doc: source, selection });
}

function selecting(source: Node, from: string, to: string): EditorState {
    const selection = TextSelection.create(
        source,
        positionOf(source, from),
        positionOf(source, to) + to.length,
    );
    return EditorState.create({ doc: source, selection });
}

// `state` once its selection has moved `by` steps, or null if nothing moved.
function shifted(state: EditorState, by: number): EditorState | null {
    const tr = state.tr;
    return shiftIndent(tr, by, true) ? state.apply(tr) : null;
}

const indents = (state: EditorState | null) => {
    const found: number[] = [];
    state!.doc.forEach((node) => found.push(indentOf(node)));
    return found;
};

describe('shiftIndent', () => {
    it('moves a paragraph in a step at a time, no further than the deepest step', () => {
        let state: EditorState | null = caretAt(doc(para('words')), 'words');
        for (let step = 1; step <= MAX_INDENT; step++) {
            state = shifted(state!, 1);
            expect(indents(state)).toEqual([step]);
        }

        expect(shifted(state!, 1)).toBeNull();
    });

    it('moves it back out, and stores nothing once it is back where it started', () => {
        const state = shifted(caretAt(doc(para('words', 2)), 'words'), -1);
        expect(indents(state)).toEqual([1]);

        const back = shifted(state!, -1);
        expect(back!.doc.firstChild!.attrs.indent).toBeNull();
        expect(shifted(back!, -1)).toBeNull();
    });

    it('moves a heading as it does a paragraph', () => {
        expect(indents(shifted(caretAt(doc(heading('Section')), 'Section'), 1))).toEqual([1]);
    });

    it('moves every block the selection touches, each from where it was', () => {
        const source = doc(para('first'), heading('second'), para('third', 3), para('fourth'));

        expect(indents(shifted(selecting(source, 'first', 'third'), 1))).toEqual([1, 1, 4, 0]);
    });

    it('moves a paragraph in a quote', () => {
        const source = doc({ type: 'blockquote', content: [para('said once')] });
        const state = shifted(caretAt(source, 'said'), 1);

        expect(indentOf(state!.doc.firstChild!.firstChild!)).toBe(1);
    });

    // A list moves as a whole: in its first item, or its only one, there is
    // no item above to nest under, and Tab moved the caret out of the note.
    it('moves the whole list an item is in, and not the item', () => {
        for (const [list, item] of [
            ['bulletList', 'listItem'],
            ['orderedList', 'listItem'],
            ['taskList', 'taskItem'],
        ]) {
            const source = doc({
                type: list,
                content: [
                    {
                        type: item,
                        attrs: item === 'taskItem' ? { checked: false } : {},
                        content: [para('only one')],
                    },
                ],
            });
            const state = shifted(caretAt(source, 'only'), 1);

            expect(indentOf(state!.doc.firstChild!), list).toBe(1);
            expect(indentOf(state!.doc.firstChild!.firstChild!.firstChild!), list).toBe(0);
        }
    });

    // A nested list sits under its item, so the list it is in is what moves.
    it('moves the outermost list from inside a nested one', () => {
        const source = doc({
            type: 'bulletList',
            content: [
                {
                    type: 'listItem',
                    content: [
                        para('parent'),
                        {
                            type: 'bulletList',
                            content: [{ type: 'listItem', content: [para('child')] }],
                        },
                    ],
                },
            ],
        });
        const state = shifted(caretAt(source, 'child'), 1);
        const nested = state!.doc.firstChild!.firstChild!.child(1);

        expect(indentOf(state!.doc.firstChild!)).toBe(1);
        expect(indentOf(nested)).toBe(0);
    });

    // A cell stays in its cell, so the press goes on to the table.
    it('leaves table cells and code alone', () => {
        const source = doc(
            {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [{ type: 'tableCell', content: [para('in a cell')] }],
                    },
                ],
            },
            { type: 'codeBlock', content: [text('let x = 1;')] },
        );

        for (const needle of ['cell', 'let']) {
            expect(shifted(caretAt(source, needle), 1), needle).toBeNull();
        }
    });

    it('only says whether it would, without dispatch', () => {
        const state = caretAt(doc(para('words')), 'words');
        const tr = state.tr;

        expect(shiftIndent(tr, 1, false)).toBe(true);
        expect(tr.docChanged).toBe(false);
    });
});

describe('atIndentableStart', () => {
    const source = doc(para('words'), {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para('a point')] }],
    });

    it('is the caret at the start of a paragraph', () => {
        expect(atIndentableStart(caretAt(source, 'words').selection)).toBe(true);
    });

    // Where Tab still leaves the note, as it does in any text box.
    it('is not the caret in the middle of one, or a selection', () => {
        expect(atIndentableStart(caretAt(source, 'words', 2).selection)).toBe(false);
        expect(atIndentableStart(selecting(source, 'words', 'words').selection)).toBe(false);
    });

    it('is not the start of a list item', () => {
        expect(atIndentableStart(caretAt(source, 'a point').selection)).toBe(false);
    });
});

describe('where the caret is in a list', () => {
    const source = doc(
        para('words'),
        {
            type: 'bulletList',
            content: [
                {
                    type: 'listItem',
                    content: [
                        para('parent'),
                        {
                            type: 'bulletList',
                            content: [{ type: 'listItem', content: [para('child')] }],
                        },
                    ],
                },
            ],
        },
        {
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [
                        {
                            type: 'tableCell',
                            content: [
                                {
                                    type: 'bulletList',
                                    content: [{ type: 'listItem', content: [para('celled')] }],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    );
    const $at = (needle: string) => caretAt(source, needle).selection.$from;

    // Shift-Tab lifts a nested item out a level before it moves the list.
    it('tells a nested item from one at the top of its list', () => {
        expect(inNestedItem($at('child'))).toBe(true);
        expect(inNestedItem($at('parent'))).toBe(false);
        expect(inNestedItem($at('words'))).toBe(false);
    });

    // Where Tab is always taken, so it never leaves the note from a list. A
    // list in a table cell is not, so Tab still goes to the next cell.
    it('knows a list that can be indented', () => {
        expect(inIndentableList($at('child'))).toBe(true);
        expect(inIndentableList($at('parent'))).toBe(true);
        expect(inIndentableList($at('words'))).toBe(false);
        expect(inIndentableList($at('celled'))).toBe(false);
    });
});

describe('the indent attribute', () => {
    it('draws a step count the stylesheet multiplies, and nothing when there is none', () => {
        const toDOM = schema.nodes.paragraph.spec.toDOM!;

        expect(toDOM(doc(para('words', 2)).firstChild!)).toEqual([
            'p',
            { 'data-indent': '2', style: '--indent: 2' },
            0,
        ]);
        expect(toDOM(doc(para('words')).firstChild!)).toEqual(['p', {}, 0]);
    });

    // A paste from a note keeps how far in it was.
    it('reads the step count back from what it drew, within the steps there are', () => {
        const [rule] = schema.nodes.paragraph.spec.parseDOM!;
        const element = (indent: string | null) =>
            ({ getAttribute: (name: string) => (name === 'data-indent' ? indent : null) }) as never;

        expect(rule.getAttrs!(element('3'))).toEqual({ indent: 3 });
        expect(rule.getAttrs!(element('40'))).toEqual({ indent: MAX_INDENT });
        expect(rule.getAttrs!(element(null))).toEqual({});
    });

    // A note nobody indents is stored exactly as it was before indenting
    // existed, and one that is indented keeps it through the sync layer.
    it('is none when it is not a number', () => {
        for (const indent of [[3], { a: 1 }, { toString: 'x' }, true, 'far', NaN, null]) {
            const node = schema.nodes.paragraph.create({ indent });
            expect(indentOf(node)).toBe(0);
            expect(node.type.spec.toDOM!(node)).toEqual(['p', {}, 0]);
        }
        expect(indentOf(schema.nodes.paragraph.create({ indent: '3' }))).toBe(3);
        expect(indentOf(schema.nodes.paragraph.create({ indent: 99 }))).toBe(MAX_INDENT);
    });

    it('is stored only on a block that is indented, and read back from there', () => {
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment('content');
        prosemirrorJSONToYXmlFragment(
            schema,
            { type: 'doc', content: [para('plain'), para('moved in', 2)] },
            fragment,
        );

        const [plain, moved] = fragment.toArray() as Y.XmlElement[];
        expect(plain.getAttributes()).toEqual({});
        expect(moved.getAttributes()).toEqual({ indent: 2 });

        const read = yXmlFragmentToProseMirrorRootNode(fragment, schema);
        expect(read.child(1).attrs.indent).toBe(2);
    });
});
