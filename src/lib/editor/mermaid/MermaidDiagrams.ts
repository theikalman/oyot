import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diagramKey, findMermaidBlocks } from './blocks';
import { cachedDrawing, currentScheme, drawDiagram, type Drawing } from './render';

const mermaidDiagramsKey = new PluginKey('mermaidDiagrams');

// A peer typing into a diagram's code while it is being read gives a new
// definition on every keystroke. Waiting this long before drawing means only
// the one they stop at is drawn.
const DRAW_DELAY_MS = 150;

/**
 * Shows a Mermaid code block as its diagram while the document is being read
 * (ADR 0038). Editing, the code is back, and is changed like any other code.
 *
 * Decorations rather than a node view: the code block itself, and how it is
 * edited, stay exactly as they are. While reading, the block's `<pre>` gets a
 * class the stylesheet hides, and a widget just before it holds the diagram.
 *
 * Interaction rather than content, so it is not in the shared schema
 * extensions, which have to load where there is no DOM.
 */
export const MermaidDiagrams = Extension.create({
    name: 'mermaidDiagrams',

    addProseMirrorPlugins() {
        const editor = this.editor;
        // The decorations for the last document, mode and scheme they were
        // worked out for. Reading, most redraws change none of the three.
        let last: { doc: ProseMirrorNode; scheme: string; set: DecorationSet } | null = null;

        return [
            new Plugin({
                key: mermaidDiagramsKey,
                props: {
                    decorations(state) {
                        if (editor.isEditable) {
                            last = null;
                            return DecorationSet.empty;
                        }
                        const scheme = currentScheme();
                        if (last && last.doc === state.doc && last.scheme === scheme) {
                            return last.set;
                        }
                        const decorations = findMermaidBlocks(state.doc).flatMap(
                            ({ pos, end, source }) => {
                                const key = diagramKey(scheme, source);
                                return [
                                    Decoration.widget(pos, () => diagramElement(key, source), {
                                        key,
                                        side: -1,
                                        ignoreSelection: true,
                                        stopEvent: () => false,
                                    }),
                                    Decoration.node(pos, end, { class: 'mermaid-source' }),
                                ];
                            },
                        );
                        const set = DecorationSet.create(state.doc, decorations);
                        last = { doc: state.doc, scheme, set };
                        return set;
                    },
                },
                view(view) {
                    // A new scheme makes every diagram's key new, so they are
                    // drawn again in its colours. Nothing in the document has
                    // changed, so the view is told by a transaction that
                    // carries no change.
                    const observer = new MutationObserver(() => {
                        if (view.isDestroyed || editor.isEditable) return;
                        view.dispatch(
                            view.state.tr
                                .setMeta(mermaidDiagramsKey, 'scheme')
                                .setMeta('addToHistory', false),
                        );
                    });
                    observer.observe(document.documentElement, {
                        attributes: true,
                        attributeFilter: ['data-scheme'],
                    });
                    return { destroy: () => observer.disconnect() };
                },
            }),
        ];
    },
});

/**
 * The element a diagram is drawn into. It starts as a placeholder about the
 * height of the code it stands for, so the page moves less when the drawing
 * arrives, and fills in once Mermaid is done, if it is still on the page.
 */
function diagramElement(key: string, source: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'mermaid-diagram';
    element.contentEditable = 'false';
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', accessibleTitle(source) ?? 'Diagram');

    const drawn = cachedDrawing(key);
    if (drawn) {
        show(element, drawn, source);
        return element;
    }

    element.classList.add('pending');
    const lines = source.split('\n').length;
    element.style.minHeight = `calc(${lines * 1.5}em + 32px)`;
    setTimeout(() => {
        // Replaced already, by a newer definition or by switching to editing.
        if (!element.isConnected) return;
        void drawDiagram(key, source).then((drawing) => {
            if (element.isConnected) show(element, drawing, source);
        });
    }, DRAW_DELAY_MS);
    return element;
}

function show(element: HTMLElement, drawing: Drawing, source: string): void {
    element.classList.remove('pending');
    element.style.minHeight = '';
    if ('svg' in drawing) {
        element.classList.remove('failed');
        // Sanitised by Mermaid, whose security level is strict.
        element.innerHTML = drawing.svg;
        return;
    }
    // A definition Mermaid cannot read shows as its code, with why, so a typo
    // never makes the block disappear.
    element.classList.add('failed');
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    const message = document.createElement('p');
    message.className = 'mermaid-error';
    message.textContent = `Couldn't draw this diagram: ${drawing.error}`;
    const code = document.createElement('pre');
    code.textContent = source;
    element.replaceChildren(message, code);
}

// Mermaid's own way of naming a diagram for a screen reader: an `accTitle:`
// line in the definition.
function accessibleTitle(source: string): string | null {
    const match = /^\s*accTitle\s*:\s*(.+)$/m.exec(source);
    return match ? match[1].trim() : null;
}
