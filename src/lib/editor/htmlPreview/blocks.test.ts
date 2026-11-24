import { describe, it, expect } from 'vitest';
import { contentSchema } from '../headlessIndex';
import { findHtmlBlocks, isHtmlLanguage, isWholePage } from './blocks';

const schema = contentSchema();
const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const code = (language: string | null, value: string) => ({
    type: 'codeBlock',
    attrs: { language },
    ...(value ? { content: [text(value)] } : {}),
});
const doc = (...content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content });

describe('isHtmlLanguage', () => {
    it('takes html in any case, with space around it, and nothing else', () => {
        for (const language of ['html', 'HTML', ' Html ']) {
            expect(isHtmlLanguage(language), language).toBe(true);
        }
        for (const language of [null, undefined, 1, '', 'htm', 'xml', 'svelte', 'html5']) {
            expect(isHtmlLanguage(language), String(language)).toBe(false);
        }
    });
});

describe('isWholePage', () => {
    it('knows a page by how it begins', () => {
        for (const source of [
            '<!doctype html><p>x',
            '\n <!DOCTYPE HTML PUBLIC "x">',
            '<html>',
            '<HTML lang="en">',
            '<html\n>',
            '<!-- saved --> <!-- twice -->\n<!doctype html>',
        ]) {
            expect(isWholePage(source), source).toBe(true);
        }
    });

    it('takes anything else for a piece of one', () => {
        for (const source of [
            '<p>x</p>',
            '<div><html></html></div>',
            '<!-- <html> --><p>x</p>',
            '<!-- never closed <html>',
            '<htmlish>',
            '<!doctype htmlish>',
            '<!doctype svg>',
            'html',
            '',
        ]) {
            expect(isWholePage(source), source).toBe(false);
        }
    });
});

describe('findHtmlBlocks', () => {
    it('finds each, with where it starts and ends, wherever it sits', () => {
        const source = doc(para('before'), code('html', '<p>a</p>'), code('js', '<p>b</p>'), {
            type: 'blockquote',
            content: [code('HTML', '<p>c</p>')],
        });
        const blocks = findHtmlBlocks(source);
        expect(blocks.map((block) => block.source)).toEqual(['<p>a</p>', '<p>c</p>']);
        for (const block of blocks) {
            const node = source.nodeAt(block.pos);
            expect(node?.type.name).toBe('codeBlock');
            expect(block.end).toBe(block.pos + node!.nodeSize);
        }
    });

    it('leaves out one with nothing in it', () => {
        expect(findHtmlBlocks(doc(code('html', ''), code('html', ' \n ')))).toEqual([]);
    });

    it('gives the same HTML the same key, and other HTML another', () => {
        const [a, b, c] = findHtmlBlocks(
            doc(code('html', '<p>a</p>'), code('html', '<p>a</p>'), code('html', '<p>b</p>')),
        );
        expect(a.key).toBe(b.key);
        expect(a.key).not.toBe(c.key);
    });
});
