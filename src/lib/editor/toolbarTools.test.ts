import { describe, it, expect, vi } from 'vitest';
import { getSchema } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { createContentExtensions } from './extensions';
import { TOOLS, pressedTools } from './toolbarTools';

// Inserting an image goes through Tauri and the sync layer, neither of which
// has any part in what the toolbar shows.
vi.mock('$lib/tiptap/commands/ImageCommand', () => ({ insertImageFromFile: vi.fn() }));

// The editor's real schema, so a tool naming a node or mark the editor does
// not have, or naming it wrongly, fails here rather than never lighting up.
const schema = getSchema(createContentExtensions());

const text = (value: string, marks: string[] = []) => ({
    type: 'text',
    text: value,
    marks: marks.map((type) => ({ type })),
});
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
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

// A caret one character into `needle`, the way a click inside a word puts it.
function caretIn(source: Node, needle: string): EditorState {
    const pos = positionOf(source, needle) + 1;
    return EditorState.create({ doc: source, selection: TextSelection.create(source, pos) });
}

function selecting(source: Node, from: string, to: string): EditorState {
    const selection = TextSelection.create(
        source,
        positionOf(source, from),
        positionOf(source, to) + to.length,
    );
    return EditorState.create({ doc: source, selection });
}

const pressed = (state: EditorState) => [...pressedTools(state)].sort();

describe('pressedTools', () => {
    it('presses nothing in plain text', () => {
        expect(pressed(caretIn(doc(para(text('plain words'))), 'words'))).toEqual([]);
    });

    it('presses the marks the text at the caret has', () => {
        const source = doc(para(text('plain '), text('loud', ['bold', 'italic'])));

        expect(pressed(caretIn(source, 'loud'))).toEqual(['bold', 'italic']);
    });

    it('presses a mark over a selection only when all of it has the mark', () => {
        const source = doc(para(text('plain '), text('loud', ['bold'])));

        expect(pressed(selecting(source, 'loud', 'loud'))).toEqual(['bold']);
        expect(pressed(selecting(source, 'plain', 'loud'))).toEqual([]);
    });

    // Bold pressed with nothing selected is waiting for what is typed next,
    // and the button has to say so or it looks like the press was lost.
    it('presses a mark the next thing typed will have', () => {
        const source = doc(para(text('plain words')));
        const state = EditorState.create({
            doc: source,
            selection: TextSelection.create(source, positionOf(source, 'words')),
            storedMarks: [schema.marks.strike.create()],
        });

        expect(pressed(state)).toEqual(['strike']);
    });

    it('presses the one heading level the caret is in', () => {
        const source = doc({
            type: 'heading',
            attrs: { level: 2 },
            content: [text('Section')],
        });

        expect(pressed(caretIn(source, 'Section'))).toEqual(['heading2']);
    });

    it('tells a task list from a bulleted one', () => {
        const source = doc(
            {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [para(text('a point'))] }],
            },
            {
                type: 'taskList',
                content: [
                    {
                        type: 'taskItem',
                        attrs: { checked: false },
                        content: [para(text('a task'))],
                    },
                ],
            },
        );

        expect(pressed(caretIn(source, 'point'))).toEqual(['bulletList']);
        expect(pressed(caretIn(source, 'task'))).toEqual(['taskList']);
    });

    it('presses a numbered list', () => {
        const source = doc({
            type: 'orderedList',
            content: [{ type: 'listItem', content: [para(text('first'))] }],
        });

        expect(pressed(caretIn(source, 'first'))).toEqual(['orderedList']);
    });

    it('presses the block the caret is in', () => {
        const source = doc(
            { type: 'blockquote', content: [para(text('said once'))] },
            { type: 'codeBlock', content: [text('let x = 1;')] },
        );

        expect(pressed(caretIn(source, 'said'))).toEqual(['blockquote']);
        expect(pressed(caretIn(source, 'let'))).toEqual(['codeBlock']);
    });

    // Insert tools do the same thing wherever the caret is, so there is
    // nothing for them to show.
    it('never presses a tool that inserts', () => {
        const source = doc({
            type: 'table',
            content: [
                {
                    type: 'tableRow',
                    content: [{ type: 'tableCell', content: [para(text('in a cell'))] }],
                },
            ],
        });

        expect(pressed(caretIn(source, 'cell'))).toEqual([]);
    });
});

describe('TOOLS', () => {
    // The ids key the buttons, and a repeat would stop the toolbar rendering.
    it('gives every tool its own id', () => {
        const ids = TOOLS.map((tool) => tool.id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});
