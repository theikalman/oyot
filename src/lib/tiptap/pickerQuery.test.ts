import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state';
import { createContentExtensions } from '$lib/editor/extensions';
import { nextPickerQuery, pickerQueryKey, type PickerQuery } from './pickerQuery';

// The schema the editor is built from, so positions here are the ones a note
// really has.
const schema = getSchema(createContentExtensions());

const para = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);

/**
 * A note of the given paragraphs, with the caret at the end of the first and
 * the editor's picker plugin minus the popup. `composing` stands in for an
 * input method part way through a word.
 */
function note(paragraphs: string[], composing = false): EditorState {
    const state = EditorState.create({
        doc: schema.node('doc', null, paragraphs.map(para)),
        plugins: [
            new Plugin<PickerQuery | null>({
                key: pickerQueryKey,
                state: {
                    init: () => null,
                    apply: (tr, prev, _old, next) => nextPickerQuery(tr, prev, next, composing),
                },
            }),
        ],
    });
    return caretAt(state, 1 + paragraphs[0].length);
}

const caretAt = (state: EditorState, pos: number) =>
    state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
const open = (state: EditorState) => state.apply(state.tr.setMeta(pickerQueryKey, 'open'));
const close = (state: EditorState) => state.apply(state.tr.setMeta(pickerQueryKey, 'close'));
const typed = (state: EditorState) => pickerQueryKey.getState(state);

/** One transaction per character, the way a keyboard sends them. */
function type(state: EditorState, text: string): EditorState {
    for (const ch of text) state = state.apply(state.tr.insertText(ch));
    return state;
}

function backspace(state: EditorState): EditorState {
    const { from } = state.selection;
    return state.apply(state.tr.delete(from - 1, from));
}

/**
 * What the collaboration binding does with a peer's edit: the whole document
 * replaced by the merged one, and the caret put back where it was in the text.
 */
function mergeFromPeer(state: EditorState, paragraphs: string[], caret: number): EditorState {
    const tr = state.tr.replace(
        0,
        state.doc.content.size,
        new Slice(Fragment.from(paragraphs.map(para)), 0, 0),
    );
    return state.apply(tr.setSelection(TextSelection.create(tr.doc, caret)));
}

describe('nextPickerQuery', () => {
    it('reads nothing until a picker opens', () => {
        expect(typed(type(note(['see ']), 'new'))).toBeNull();
    });

    it('opens empty, at the caret', () => {
        expect(typed(open(note(['see '])))).toEqual({ from: 5, to: 5, query: '' });
    });

    // What was broken on Android: the keyboard's key events carry no
    // characters, so nothing but the text in the note says what was typed.
    it('reads what is typed after it', () => {
        expect(typed(type(open(note(['see '])), 'new'))).toEqual({ from: 5, to: 8, query: 'new' });
    });

    it('keeps a space, since a tag can be a phrase', () => {
        expect(typed(type(open(note(['see '])), 'house move'))?.query).toBe('house move');
    });

    // An input method replaces the word it is composing as it goes, and
    // autocorrect replaces it whole. The replacement starts exactly where the
    // query does, and must not push the start along.
    it('reads a word the keyboard replaced whole', () => {
        let state = type(open(note(['see '])), 'teh');
        state = state.apply(state.tr.insertText('the', 5, 8));
        expect(typed(state)).toEqual({ from: 5, to: 8, query: 'the' });
    });

    it('stays open, empty, when what was typed is deleted', () => {
        let state = type(open(note(['see '])), 'ne');
        state = backspace(backspace(state));
        expect(typed(state)).toEqual({ from: 5, to: 5, query: '' });
    });

    it('lets go when the caret moves back past where it started', () => {
        const state = type(open(note(['see '])), 'new');
        expect(typed(caretAt(state, 4))).toBeNull();
    });

    it('follows the caret back and forth within what was typed', () => {
        const state = type(open(note(['see '])), 'new');
        expect(typed(caretAt(state, 6))).toEqual({ from: 5, to: 6, query: 'n' });
    });

    it('lets go when the caret moves to another paragraph', () => {
        const state = type(open(note(['see ', 'other'])), 'new');
        expect(typed(caretAt(state, 12))).toBeNull();
    });

    it('lets go when a newline ends the line', () => {
        const state = type(open(note(['see '])), 'new');
        expect(typed(state.apply(state.tr.split(state.selection.from)))).toBeNull();
    });

    it('lets go of a selection', () => {
        const state = type(open(note(['see '])), 'new');
        const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5, 8)));
        expect(typed(selected)).toBeNull();
    });

    it('keeps reading while an input method holds a selection over its word', () => {
        const state = type(open(note(['see '], true)), 'new');
        const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5, 8)));
        expect(typed(selected)).toEqual({ from: 5, to: 8, query: 'new' });
    });

    it('lets go when the picker closes', () => {
        expect(typed(close(type(open(note(['see '])), 'new')))).toBeNull();
    });

    // The binding maps every position inside the old document to its start.
    // Followed naively, the query would become everything from the top of the
    // note to the caret.
    it('finds what was typed again after a peer edits the note', () => {
        const state = type(open(note(['see '])), 'new');
        // A paragraph added above, so everything after it moves along by six.
        const merged = mergeFromPeer(state, ['peer', 'see new'], 14);
        expect(typed(merged)).toEqual({ from: 11, to: 14, query: 'new' });
    });

    it('stays open, empty, after a peer edits the note before anything is typed', () => {
        const merged = mergeFromPeer(open(note(['see '])), ['peer', 'see '], 11);
        expect(typed(merged)).toEqual({ from: 11, to: 11, query: '' });
    });

    it('lets go when what was typed is no longer in front of the caret', () => {
        // An undo arrives the same way, and takes the typing with it.
        const state = type(open(note(['see '])), 'new');
        expect(typed(mergeFromPeer(state, ['see '], 5))).toBeNull();
    });
});
