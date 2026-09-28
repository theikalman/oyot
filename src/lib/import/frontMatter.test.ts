import { describe, it, expect } from 'vitest';
import { splitFrontMatter } from './frontMatter';

function values(text: string) {
    return Object.fromEntries(splitFrontMatter(text).values);
}

describe('splitFrontMatter', () => {
    it('splits the block off the top of the file', () => {
        const split = splitFrontMatter('---\ntitle: Groceries\n---\n\n# Groceries\n');
        expect(Object.fromEntries(split.values)).toEqual({ title: 'Groceries' });
        expect(split.body).toBe('\n# Groceries\n');
    });

    it('accepts ... as the closing line, as YAML does', () => {
        expect(splitFrontMatter('---\ntitle: A\n...\nbody').body).toBe('body');
    });

    it('accepts an empty block', () => {
        const split = splitFrontMatter('---\n---\nbody');
        expect(split.values.size).toBe(0);
        expect(split.body).toBe('body');
    });

    it('leaves a file without front matter as it is', () => {
        const text = '# Groceries\n\n---\n\nmilk\n';
        expect(splitFrontMatter(text)).toEqual({ values: new Map(), body: text });
    });

    it('leaves an unclosed block as Markdown', () => {
        const text = '---\ntitle: A\n\nbody';
        expect(splitFrontMatter(text).body).toBe(text);
    });

    // A rule, some words, and another rule is a document, and taking it for
    // front matter would drop the words.
    it('only takes a block that starts with a key', () => {
        const text = '---\nJust a thought.\n---\n';
        expect(splitFrontMatter(text).body).toBe(text);
        expect(splitFrontMatter('---\n# a comment\ntitle: A\n---\n').values.get('title')).toBe('A');
    });

    it('does not take a rule further down for front matter', () => {
        const text = 'intro\n---\ntitle: A\n---\n';
        expect(splitFrontMatter(text).body).toBe(text);
    });
});

describe('front matter values', () => {
    it('reads plain, double-quoted and single-quoted text', () => {
        expect(
            values(
                [
                    '---',
                    'plain: Trip to Kyoto',
                    'double: "He said \\"no\\": true"',
                    "single: 'it''s done'",
                    'escaped: "caf\\u00e9 \\\\ tab\\there"',
                    '---',
                ].join('\n'),
            ),
        ).toEqual({
            plain: 'Trip to Kyoto',
            double: 'He said "no": true',
            single: "it's done",
            escaped: 'café \\ tab\there',
        });
    });

    it('keeps a colon inside a value', () => {
        expect(values('---\ntitle: Meeting: budget\n---\n').title).toBe('Meeting: budget');
    });

    it('ends a plain value at a comment, but not at a # inside a word', () => {
        expect(values('---\na: Notes # draft\nb: C# notes\n---\n')).toEqual({
            a: 'Notes',
            b: 'C# notes',
        });
    });

    it('reads a list written on one line', () => {
        expect(values('---\ntags: ["shopping", \'house move\', plain]\n---\n').tags).toEqual([
            'shopping',
            'house move',
            'plain',
        ]);
        expect(values('---\ntags: []\n---\n').tags).toEqual([]);
        expect(values('---\ntags: ["a, b", c]\n---\n').tags).toEqual(['a, b', 'c']);
    });

    it('reads a list written a line to an item, indented or not', () => {
        expect(values('---\ntags:\n  - work\n  - "q3 plan"\ntitle: A\n---\n')).toEqual({
            tags: ['work', 'q3 plan'],
            title: 'A',
        });
        expect(values('---\ntags:\n- work\n- home\n---\n').tags).toEqual(['work', 'home']);
    });

    it('reads folded and literal blocks', () => {
        expect(values('---\ntitle: >\n  A long\n  title\nnext: x\n---\n')).toEqual({
            title: 'A long title',
            next: 'x',
        });
        expect(values('---\nnote: |\n  one\n  two\n---\n').note).toBe('one\ntwo');
    });

    it('reads a shape it does not handle as nothing, and carries on', () => {
        expect(
            values(
                [
                    '---',
                    'author:',
                    '  name: Aji',
                    '  site: example.com',
                    'inline: {a: 1}',
                    'nested: [a, [b]]',
                    'empty:',
                    'title: Still read',
                    '---',
                ].join('\n'),
            ),
        ).toEqual({
            author: null,
            inline: null,
            nested: null,
            empty: null,
            title: 'Still read',
        });
    });

    it('reads a value that is only a comment as nothing', () => {
        expect(values('---\ntitle: #not a title\n---\n').title).toBeNull();
    });
});
