import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

/** A run of a code block's text and the highlight.js classes it is drawn with. */
export interface Highlight {
    from: number;
    to: number;
    className: string;
}

// The tree lowlight gives back, as much of it as is read here.
type HastNode =
    | { type: 'text'; value: string }
    | { type: 'element'; properties?: { className?: unknown }; children: HastNode[] }
    | { type: 'root' | 'comment' | 'doctype'; children?: HastNode[] };

/**
 * The runs of one piece of code to colour, counted from its first character.
 * Nothing for a language highlight.js does not know: guessing one would
 * colour prose and config files as if they were code.
 */
export function highlightCode(code: string, language: string): Highlight[] {
    const name = language.trim().toLowerCase();
    if (name === '' || !lowlight.registered(name)) return [];
    const highlights: Highlight[] = [];
    let offset = 0;
    const walk = (node: HastNode) => {
        if (node.type === 'text') {
            offset += node.value.length;
            return;
        }
        const from = offset;
        for (const child of node.children ?? []) walk(child);
        const classes = node.type === 'element' ? node.properties?.className : undefined;
        if (Array.isArray(classes) && classes.length > 0 && offset > from) {
            highlights.push({ from, to: offset, className: classes.join(' ') });
        }
    };
    walk(lowlight.highlight(name, code) as HastNode);
    return highlights;
}

/** Every run to colour in a document, at its place in the document. */
export function findHighlights(doc: ProseMirrorNode): Highlight[] {
    const highlights: Highlight[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return true;
        // The text starts just inside the block.
        for (const run of runsFor(node)) {
            highlights.push({ ...run, from: pos + 1 + run.from, to: pos + 1 + run.to });
        }
        // A code block holds only text.
        return false;
    });
    return highlights;
}

// A block nobody has touched is the same node from one document to the next,
// so typing in one block does not highlight every other again.
const cache = new WeakMap<ProseMirrorNode, Highlight[]>();

function runsFor(node: ProseMirrorNode): Highlight[] {
    let runs = cache.get(node);
    if (!runs) {
        const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
        runs = highlightCode(node.textContent, language);
        cache.set(node, runs);
    }
    return runs;
}

/**
 * Colours the code in a code block that names a language highlight.js knows,
 * while reading and while editing.
 *
 * Inline decorations carrying highlight.js's own `hljs-*` classes, which the
 * stylesheet colours from the scheme's `--syntax-*` variables. A decoration
 * rather than marks or a different code block node, so the schema the sync
 * layer shares is untouched and nothing about colouring is ever stored.
 */
export const CodeHighlight = Extension.create({
    name: 'codeHighlight',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('codeHighlight'),
                state: {
                    init: (_, state) => highlightSet(state.doc),
                    apply: (tr, set) => (tr.docChanged ? highlightSet(tr.doc) : set),
                },
                props: {
                    decorations(state) {
                        return this.getState(state);
                    },
                },
            }),
        ];
    },
});

function highlightSet(doc: ProseMirrorNode): DecorationSet {
    return DecorationSet.create(
        doc,
        findHighlights(doc).map(({ from, to, className }) =>
            Decoration.inline(from, to, { class: className }),
        ),
    );
}
