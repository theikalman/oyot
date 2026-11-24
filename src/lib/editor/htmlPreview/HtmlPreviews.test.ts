// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from '@tiptap/pm/state';
import type { DecorationSet, EditorView } from '@tiptap/pm/view';
import { contentSchema } from '../headlessIndex';
import { findKey, findPlugin, setFindQuery } from '../findInDocument';
import { choosePreview, HTML_VIEW_EVENT, htmlPreviewsPlugin, showsPage } from './HtmlPreviews';
import { findHtmlBlocks } from './blocks';

const schema = contentSchema();
const PAGE = '<!doctype html><title>T</title><p>whole</p>';
const PIECE = '<p>piece</p>';

/** An editor's state over HTML blocks, and what it would draw. */
function open(...sources: string[]) {
    let editable = false;
    const plugin = htmlPreviewsPlugin(() => editable);
    const doc = schema.nodeFromJSON({
        type: 'doc',
        content: sources.map((source) => ({
            type: 'codeBlock',
            attrs: { language: 'html' },
            content: [{ type: 'text', text: source }],
        })),
    });
    const view = {
        state: EditorState.create({ doc, plugins: [findPlugin(), plugin] }),
        dispatch(tr: ReturnType<typeof choosePreview>) {
            view.state = view.state.apply(tr);
        },
    };
    const set = () => plugin.props.decorations!.call(plugin, view.state) as DecorationSet;
    return {
        view,
        edit: (on: boolean) => (editable = on),
        shown: () => findHtmlBlocks(view.state.doc).map((b) => showsPage(view.state, b)),
        decorations: () => set().find(),
        /** Draw the widget above a block. */
        widget(index = 0): HTMLElement {
            const { pos } = findHtmlBlocks(view.state.doc)[index];
            type Widget = { type: { toDOM?: (view: EditorView) => HTMLElement } };
            const drawn = set()
                .find(pos, pos)
                .map((decoration) => (decoration as unknown as Widget).type.toDOM)
                .find((toDOM) => toDOM !== undefined);
            return drawn!(view as unknown as EditorView);
        },
    };
}

const labels = (element: HTMLElement) =>
    [...element.querySelectorAll('button')].map((button) => button.textContent);

describe('showing an HTML block', () => {
    it('is the page for a whole page, and the code for a piece of one', () => {
        expect(open(PAGE, PIECE).shown()).toEqual([true, false]);
    });

    it('is what the reader chose, for that HTML alone', () => {
        const { view, shown } = open(PAGE, PIECE, PIECE, '<p>other</p>');
        const [page, piece] = findHtmlBlocks(view.state.doc);
        view.dispatch(choosePreview(view.state.tr, page.key, false));
        view.dispatch(choosePreview(view.state.tr, piece.key, true));
        expect(shown()).toEqual([false, true, true, false]);
        view.dispatch(choosePreview(view.state.tr, page.key, true));
        expect(shown()).toEqual([true, true, true, false]);
    });

    it('does not change the document, or what can be undone', () => {
        const { view } = open(PAGE);
        const tr = choosePreview(view.state.tr, findHtmlBlocks(view.state.doc)[0].key, false);
        expect(tr.docChanged).toBe(false);
        expect(tr.getMeta('addToHistory')).toBe(false);
    });

    it('keeps the choice when something else in the note changes', () => {
        const { view, shown } = open(PAGE, PIECE);
        const [page, piece] = findHtmlBlocks(view.state.doc);
        view.dispatch(choosePreview(view.state.tr, page.key, false));
        view.dispatch(view.state.tr.insertText('!', piece.end - 1));
        expect(shown()).toEqual([false, false]);
    });

    it('is the code of the block that holds what is being looked for', () => {
        const { view, shown } = open(PAGE, PAGE.replace('whole', 'other'));
        setFindQuery(view, 'whole');
        expect(findKey.getState(view.state)?.matches).toHaveLength(1);
        expect(shown()).toEqual([false, true]);
        setFindQuery(view, '');
        expect(shown()).toEqual([true, true]);
    });
});

describe('what is drawn', () => {
    it('is a bar above each block, and the code hidden where the page is shown', () => {
        const { decorations, view } = open(PAGE, PIECE);
        const [page] = findHtmlBlocks(view.state.doc);
        const hiding = decorations().filter(({ from, to }) => from < to);
        expect(hiding.map(({ from, to }) => [from, to])).toEqual([[page.pos, page.end]]);
        expect(decorations()).toHaveLength(3);
    });

    it('is nothing while editing', () => {
        const { decorations, edit } = open(PAGE, PIECE);
        edit(true);
        expect(decorations()).toEqual([]);
    });

    it('is drawn again only when it would say something else', () => {
        const { decorations, view } = open(PAGE);
        const key = () => decorations().find(({ spec }) => spec.key)!.spec.key;
        const before = key();
        view.dispatch(view.state.tr.setMeta('anything', 1));
        expect(key()).toBe(before);
        const [block] = findHtmlBlocks(view.state.doc);
        view.dispatch(choosePreview(view.state.tr, block.key, false));
        expect(key()).not.toBe(before);
    });

    it('switches with its button', () => {
        const { widget, shown } = open(PAGE);
        expect(labels(widget())).toEqual(['Show code', 'Full size']);
        widget().querySelector('button')!.click();
        expect(shown()).toEqual([false]);
        expect(labels(widget())).toEqual(['Show page', 'Full size']);
        widget().querySelector('button')!.click();
        expect(shown()).toEqual([true]);
    });

    it('asks the editor around it for the full size', () => {
        const element = open(PIECE).widget();
        const parent = document.createElement('div');
        parent.append(element);
        const asked: unknown[] = [];
        parent.addEventListener(HTML_VIEW_EVENT, (e) => asked.push((e as CustomEvent).detail));
        element.querySelectorAll('button')[1].click();
        expect(asked).toEqual([{ source: PIECE }]);
    });

    it('makes no page of a block that is gone by the time it would', async () => {
        const element = open(PAGE).widget();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(element.querySelector('iframe')).toBeNull();
    });
});
