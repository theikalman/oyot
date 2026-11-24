import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { findState } from '../findInDocument';
import { findHtmlBlocks, isWholePage, type HtmlBlock } from './blocks';
import { createFrame, fitToPage } from './frame';

/**
 * Asked for by a preview's Full size button, on the editor's DOM, for the
 * editor around it to answer, as an image's is.
 */
export const HTML_VIEW_EVENT = 'oyot-html-view';

export interface HtmlViewRequest {
    source: string;
}

/** Which blocks the reader has switched to the page or to the code, by key. */
type Choices = ReadonlyMap<string, boolean>;

const htmlPreviewsKey = new PluginKey<Choices>('htmlPreviews');

// A peer typing in a block while it is being read makes a new page of it on
// every keystroke. Waiting this long means only the one they stop at is made.
const SHOW_DELAY_MS = 150;

/** Show a block as its page, or as its code. */
export function choosePreview(tr: Transaction, key: string, page: boolean): Transaction {
    return tr.setMeta(htmlPreviewsKey, { key, page }).setMeta('addToHistory', false);
}

/**
 * Whether a block is showing as its page.
 *
 * What the reader chose, and otherwise the page for a whole page and the code
 * for a piece of one, which is more often there to be read as code. Text being
 * looked for that is in the block shows the code whatever was chosen, since
 * that is where the match is.
 */
export function showsPage(state: EditorState, block: HtmlBlock): boolean {
    const found = findState(state).matches;
    if (found.some(({ from, to }) => from > block.pos && to < block.end)) return false;
    return htmlPreviewsKey.getState(state)?.get(block.key) ?? isWholePage(block.source);
}

export function htmlPreviewsPlugin(isEditable: () => boolean): Plugin<Choices> {
    return new Plugin<Choices>({
        key: htmlPreviewsKey,
        state: {
            init: () => new Map(),
            apply(tr, choices) {
                const chosen = tr.getMeta(htmlPreviewsKey) as
                    { key: string; page: boolean } | undefined;
                return chosen ? new Map(choices).set(chosen.key, chosen.page) : choices;
            },
        },
        props: {
            decorations(state) {
                if (isEditable()) return DecorationSet.empty;
                return DecorationSet.create(
                    state.doc,
                    findHtmlBlocks(state.doc).flatMap((block) => decorate(state, block)),
                );
            },
        },
    });
}

/**
 * Lets an HTML code block be seen as the page it makes while the document is
 * being read (ADR 0043). Editing, it is code like any other.
 *
 * Decorations, as a Mermaid diagram's are, so the code block and the schema
 * are untouched and nothing about which way it is shown is stored.
 */
export const HtmlPreviews = Extension.create({
    name: 'htmlPreviews',

    addProseMirrorPlugins() {
        return [htmlPreviewsPlugin(() => this.editor.isEditable)];
    },
});

function decorate(state: EditorState, block: HtmlBlock): Decoration[] {
    const page = showsPage(state, block);
    const widget = Decoration.widget(
        block.pos,
        (view) => previewElement(view, block.key, block.source, page),
        {
            // The same element for as long as it says the same thing, so a
            // page is not made again by every redraw.
            key: `html:${page}:${block.key}`,
            side: -1,
            ignoreSelection: true,
            // The buttons are the page's to handle, not the editor's.
            stopEvent: () => true,
        },
    );
    return page
        ? [widget, Decoration.node(block.pos, block.end, { class: 'html-source' })]
        : [widget];
}

function previewElement(view: EditorView, key: string, source: string, page: boolean): HTMLElement {
    const element = document.createElement('div');
    element.className = 'html-preview';
    element.contentEditable = 'false';

    const bar = document.createElement('div');
    bar.className = 'html-preview-bar';
    bar.append(
        button(page ? 'Show code' : 'Show page', () => {
            view.dispatch(choosePreview(view.state.tr, key, !page));
        }),
        button('Full size', () => {
            const detail: HtmlViewRequest = { source };
            element.dispatchEvent(new CustomEvent(HTML_VIEW_EVENT, { bubbles: true, detail }));
        }),
    );
    element.append(bar);

    if (page) {
        const holder = document.createElement('div');
        holder.className = 'html-preview-page';
        element.append(holder);
        setTimeout(() => {
            // Replaced already, by newer HTML or by switching to editing.
            if (!element.isConnected) return;
            const frame = createFrame(source);
            fitToPage(frame);
            holder.append(frame);
        }, SHOW_DELAY_MS);
    }
    return element;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
}
