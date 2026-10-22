import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** A code block that names its language, and that language as written. */
export interface LanguageLabel {
    pos: number;
    end: number;
    language: string;
}

/**
 * Every code block that names a language, wherever it sits. A block with no
 * language, or only space for one, has nothing to label.
 */
export function findLanguageLabels(doc: ProseMirrorNode): LanguageLabel[] {
    const labels: LanguageLabel[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return true;
        const language = typeof node.attrs.language === 'string' ? node.attrs.language.trim() : '';
        if (language !== '') labels.push({ pos, end: pos + node.nodeSize, language });
        // A code block holds only text.
        return false;
    });
    return labels;
}

/**
 * Shows a code block's language in its corner, so a block typed as
 * ` ```mermaid ` says it will be drawn as a diagram, and any other says what
 * it holds. The language is otherwise only in the document, with nothing on
 * screen to show it was taken.
 *
 * A `data-language` attribute on the block's `<pre>`, which the stylesheet
 * shows. A decoration rather than part of the code block's own markup, so the
 * schema the sync layer shares is untouched.
 */
export const CodeBlockLanguage = Extension.create({
    name: 'codeBlockLanguage',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('codeBlockLanguage'),
                state: {
                    init: (_, state) => labelSet(state.doc),
                    apply: (tr, set) => (tr.docChanged ? labelSet(tr.doc) : set),
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

function labelSet(doc: ProseMirrorNode): DecorationSet {
    return DecorationSet.create(
        doc,
        findLanguageLabels(doc).map(({ pos, end, language }) =>
            Decoration.node(pos, end, { 'data-language': language }),
        ),
    );
}
