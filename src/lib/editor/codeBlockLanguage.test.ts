import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { createContentExtensions } from './extensions';
import { findLanguageLabels } from './codeBlockLanguage';

const schema = getSchema(createContentExtensions());

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const code = (language: string | null, value = 'x') => ({
    type: 'codeBlock',
    attrs: { language },
    content: [text(value)],
});
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

describe('findLanguageLabels', () => {
    it('labels each code block that names a language, as written', () => {
        const source = doc(code('mermaid'), para('between'), code('TypeScript'));
        expect(findLanguageLabels(source).map((l) => l.language)).toEqual([
            'mermaid',
            'TypeScript',
        ]);
    });

    it('covers the whole block', () => {
        const source = doc(para('before'), code('rust', 'fn main() {}'));
        const [label] = findLanguageLabels(source);
        const node = source.nodeAt(label.pos);
        expect(node?.type.name).toBe('codeBlock');
        expect(label.end).toBe(label.pos + node!.nodeSize);
    });

    it('trims the space around a language', () => {
        expect(findLanguageLabels(doc(code(' js ')))[0].language).toBe('js');
    });

    it('leaves out a block with no language', () => {
        expect(findLanguageLabels(doc(code(null), code(''), code('   ')))).toEqual([]);
    });

    it('finds a block inside a list item', () => {
        const source = doc({
            type: 'bulletList',
            content: [{ type: 'listItem', content: [para('item'), code('sql')] }],
        });
        expect(findLanguageLabels(source).map((l) => l.language)).toEqual(['sql']);
    });
});
