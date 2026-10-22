import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Finding the code blocks that hold a Mermaid diagram, kept free of the DOM
 * and of Mermaid itself so it can be tested on its own.
 */

/** A code block whose diagram is drawn while reading. */
export interface MermaidBlock {
    /** Where the code block starts. */
    pos: number;
    /** Where it ends. */
    end: number;
    /** The diagram's definition, the block's text. */
    source: string;
}

/**
 * Whether a code block's language marks it as a diagram. Only `mermaid`, as
 * other apps write it on a fence: trimmed, in any case. `mmd` is a file
 * extension, not a fence language.
 */
export function isMermaidLanguage(language: unknown): boolean {
    return typeof language === 'string' && language.trim().toLowerCase() === 'mermaid';
}

/**
 * Every Mermaid code block in the document, wherever it sits: at the top
 * level, in a list item, in a quote. An empty one is left out, having nothing
 * to draw.
 */
export function findMermaidBlocks(doc: ProseMirrorNode): MermaidBlock[] {
    const blocks: MermaidBlock[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return true;
        const source = node.textContent;
        if (isMermaidLanguage(node.attrs.language) && source.trim() !== '') {
            blocks.push({ pos, end: pos + node.nodeSize, source });
        }
        // A code block holds only text.
        return false;
    });
    return blocks;
}

/**
 * What a drawn diagram depends on, as one string: the colour scheme it was
 * drawn in and its definition. Used as the widget's key, so ProseMirror keeps
 * a diagram's element when neither has changed, and as the cache key.
 */
export function diagramKey(scheme: string, source: string): string {
    return `mermaid:${scheme}:${fnv1a(source)}:${source.length}`;
}

// FNV-1a, 32 bits. Not for security: it only has to tell definitions apart,
// and the length beside it makes a collision less likely still.
function fnv1a(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
