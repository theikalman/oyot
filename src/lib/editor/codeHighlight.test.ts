import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { createContentExtensions } from './extensions';
import { findHighlights, highlightCode } from './codeHighlight';

const schema = getSchema(createContentExtensions());

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const code = (language: string | null, value: string) => ({
    type: 'codeBlock',
    attrs: { language },
    content: [text(value)],
});
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

describe('highlightCode', () => {
    it('marks each word with what it is', () => {
        const source = 'const n = 1;';
        const runs = highlightCode(source, 'javascript');
        const named = runs.map((r) => [source.slice(r.from, r.to), r.className]);
        expect(named).toContainEqual(['const', 'hljs-keyword']);
        expect(named).toContainEqual(['1', 'hljs-number']);
    });

    it('takes a language by its alias, in any case', () => {
        expect(highlightCode('let x = 1', ' TS ')).not.toEqual([]);
        expect(highlightCode('fn main() {}', 'rs')).not.toEqual([]);
    });

    it('colours nothing for a language it does not know, or none', () => {
        expect(highlightCode('graph TD; A-->B', 'mermaid')).toEqual([]);
        expect(highlightCode('const n = 1;', '')).toEqual([]);
    });
});

describe('findHighlights', () => {
    it('places each run over its text in the document', () => {
        const source = doc(para('before'), code('python', 'def f(): pass'), code(null, 'def'));
        const words = findHighlights(source).map((h) => source.textBetween(h.from, h.to));
        expect(words).toContain('def');
        expect(words).toContain('pass');
        // The block with no language is left alone.
        expect(words.filter((w) => w === 'def')).toHaveLength(1);
    });
});
