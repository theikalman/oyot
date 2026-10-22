import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { createContentExtensions } from '../extensions';
import { diagramKey, findMermaidBlocks, isMermaidLanguage } from './blocks';

const schema = getSchema(createContentExtensions());

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const code = (language: string | null, value: string) => ({
    type: 'codeBlock',
    attrs: { language },
    ...(value ? { content: [text(value)] } : {}),
});
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

const FLOW = 'flowchart LR\n  a --> b';

describe('isMermaidLanguage', () => {
    it('takes mermaid in any case, with space around it', () => {
        expect(isMermaidLanguage('mermaid')).toBe(true);
        expect(isMermaidLanguage('Mermaid')).toBe(true);
        expect(isMermaidLanguage(' mermaid ')).toBe(true);
    });

    it('takes nothing else', () => {
        expect(isMermaidLanguage(null)).toBe(false);
        expect(isMermaidLanguage(undefined)).toBe(false);
        expect(isMermaidLanguage('js')).toBe(false);
        expect(isMermaidLanguage('mermaidx')).toBe(false);
        expect(isMermaidLanguage('mmd')).toBe(false);
    });
});

describe('findMermaidBlocks', () => {
    it('finds none in a document without one', () => {
        expect(findMermaidBlocks(doc(para('hello'), code('js', 'let x = 1;')))).toEqual([]);
    });

    it('finds one, with where it starts and ends', () => {
        const source = doc(para('before'), code('mermaid', FLOW));
        const [block, ...rest] = findMermaidBlocks(source);
        expect(rest).toEqual([]);
        expect(block.source).toBe(FLOW);
        const node = source.nodeAt(block.pos);
        expect(node?.type.name).toBe('codeBlock');
        expect(block.end).toBe(block.pos + node!.nodeSize);
    });

    it('finds several among other code blocks, in order', () => {
        const source = doc(
            code('mermaid', 'pie\n "a": 1'),
            code('rust', 'fn main() {}'),
            code('Mermaid', FLOW),
        );
        expect(findMermaidBlocks(source).map((b) => b.source)).toEqual(['pie\n "a": 1', FLOW]);
    });

    it('finds one inside a list item and a quote', () => {
        const source = doc(
            {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [para('item'), code('mermaid', FLOW)] }],
            },
            { type: 'blockquote', content: [code('mermaid', 'pie\n "b": 2')] },
        );
        expect(findMermaidBlocks(source).map((b) => b.source)).toEqual([FLOW, 'pie\n "b": 2']);
    });

    it('leaves out an empty one', () => {
        expect(findMermaidBlocks(doc(code('mermaid', ''), code('mermaid', '  \n')))).toEqual([]);
    });
});

describe('diagramKey', () => {
    it('is the same for the same scheme and definition', () => {
        expect(diagramKey('nord', FLOW)).toBe(diagramKey('nord', FLOW));
    });

    it('changes with either', () => {
        expect(diagramKey('nord', FLOW)).not.toBe(diagramKey('latte', FLOW));
        expect(diagramKey('nord', FLOW)).not.toBe(diagramKey('nord', `${FLOW}\n  b --> c`));
    });
});
