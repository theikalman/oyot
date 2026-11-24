import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { sourceKey } from '../sourceKey';

/**
 * Finding the code blocks that hold HTML, kept free of the DOM so it can be
 * tested on its own.
 */

/** A code block whose HTML can be shown as the page it makes. */
export interface HtmlBlock {
    /** Where the code block starts. */
    pos: number;
    /** Where it ends. */
    end: number;
    /** The HTML, the block's text. */
    source: string;
    /** What stands for that HTML: in a widget's key, and for a reader's choice. */
    key: string;
}

/** Whether a code block's language marks it as HTML: `html`, trimmed, in any case. */
export function isHtmlLanguage(language: unknown): boolean {
    return typeof language === 'string' && language.trim().toLowerCase() === 'html';
}

/**
 * Whether HTML is a whole page rather than a piece of one: it begins with a
 * doctype or an `<html>` tag, after any comments.
 */
export function isWholePage(source: string): boolean {
    let rest = source.trimStart();
    while (rest.startsWith('<!--')) {
        const close = rest.indexOf('-->');
        if (close < 0) return false;
        rest = rest.slice(close + '-->'.length).trimStart();
    }
    return /^<(!doctype html|html)(?=[\s>])/i.test(rest);
}

/**
 * Every HTML code block in the document, wherever it sits. An empty one is
 * left out, having nothing to show.
 */
export function findHtmlBlocks(doc: ProseMirrorNode): HtmlBlock[] {
    const blocks: HtmlBlock[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock') return true;
        const source = node.textContent;
        if (isHtmlLanguage(node.attrs.language) && source.trim() !== '') {
            blocks.push({ pos, end: pos + node.nodeSize, source, key: keyOf(node, source) });
        }
        // A code block holds only text.
        return false;
    });
    return blocks;
}

// A page can be long, and a block nobody has touched is the same node from
// one document to the next, so each is gone through once.
const keys = new WeakMap<ProseMirrorNode, string>();

function keyOf(node: ProseMirrorNode, source: string): string {
    let key = keys.get(node);
    if (key === undefined) {
        key = sourceKey(source);
        keys.set(node, key);
    }
    return key;
}
