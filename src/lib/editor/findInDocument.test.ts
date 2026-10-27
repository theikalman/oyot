import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { createContentExtensions } from './extensions';
import { findMatches, findPlugin, findState, setFindQuery, stepFind } from './findInDocument';

const schema = getSchema(createContentExtensions());

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

const found = (source: ReturnType<typeof doc>, query: string) =>
    findMatches(source, query).map((m) => source.textBetween(m.from, m.to));

describe('findMatches', () => {
    it('finds every place, ignoring case', () => {
        const source = doc(para(text('Apple and apple')), para(text('APPLE pie')));
        expect(found(source, 'apple')).toEqual(['Apple', 'apple', 'APPLE']);
    });

    it('finds nothing for nothing', () => {
        expect(findMatches(doc(para(text('anything'))), '')).toEqual([]);
    });

    it('finds across marks within a paragraph', () => {
        const source = doc(para(text('bo'), text('ld', [{ type: 'bold' }]), text(' type')));
        expect(found(source, 'bold t')).toEqual(['bold t']);
    });

    it('does not find across paragraphs or a line break', () => {
        const source = doc(
            para(text('one')),
            para(text('two')),
            para(text('three'), { type: 'hardBreak' }, text('four')),
        );
        expect(found(source, 'onetwo')).toEqual([]);
        expect(found(source, 'threefour')).toEqual([]);
        expect(found(source, 'four')).toEqual(['four']);
    });

    it('finds in headings, lists and code', () => {
        const source = doc(
            { type: 'heading', attrs: { level: 2 }, content: [text('A note')] },
            {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [para(text('a note item'))] }],
            },
            { type: 'codeBlock', content: [text('// note')] },
        );
        expect(found(source, 'note')).toEqual(['note', 'note', 'note']);
    });
});

describe('findPlugin', () => {
    // A view as much as the plugin's helpers need: a state that each
    // transaction moves on.
    function viewOf(...content: unknown[]) {
        const view = {
            state: EditorState.create({ doc: doc(...content), plugins: [findPlugin()] }),
            dispatch(tr: Transaction) {
                view.state = view.state.apply(tr);
            },
        };
        return view;
    }

    it('steps through the matches, wrapping round', () => {
        const view = viewOf(para(text('cat, cat and cat')));
        setFindQuery(view, 'cat');
        expect(findState(view.state).matches).toHaveLength(3);
        expect(findState(view.state).current).toBe(0);
        stepFind(view, 1);
        stepFind(view, 1);
        stepFind(view, 1);
        expect(findState(view.state).current).toBe(0);
        stepFind(view, -1);
        expect(findState(view.state).current).toBe(2);
    });

    it('finds again when the document changes, staying on the same match', () => {
        const view = viewOf(para(text('a dog, a dog')));
        setFindQuery(view, 'dog');
        stepFind(view, 1);
        view.dispatch(view.state.tr.insertText('dog ', 1));
        const { matches, current } = findState(view.state);
        expect(matches).toHaveLength(3);
        expect(current).toBe(2);
    });

    it('lights up nothing once the query is cleared', () => {
        const view = viewOf(para(text('one dog')));
        setFindQuery(view, 'dog');
        setFindQuery(view, '');
        expect(findState(view.state).matches).toEqual([]);
    });

    it('is nothing in a state without it', () => {
        const state = EditorState.create({ schema });
        expect(findState(state)).toEqual({ query: '', matches: [], current: -1 });
    });
});
