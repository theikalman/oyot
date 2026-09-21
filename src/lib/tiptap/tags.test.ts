import { describe, it, expect } from 'vitest';
import {
    MAX_TAG_LENGTH,
    mergeTagNames,
    normalizeTagName,
    tagPickerItems,
    type TagSummary,
} from './tags';

describe('normalizeTagName', () => {
    it('lowercases, because a tag has one spelling', () => {
        expect(normalizeTagName('Work')).toBe('work');
        expect(normalizeTagName('WORK')).toBe('work');
    });

    it('drops a hash the user typed out of habit', () => {
        expect(normalizeTagName('#work')).toBe('work');
        expect(normalizeTagName('##work')).toBe('work');
        expect(normalizeTagName(' # work')).toBe('work');
    });

    it('keeps a hash that is inside the name', () => {
        expect(normalizeTagName('c#')).toBe('c#');
    });

    it('trims and collapses whitespace, since the chip is one line', () => {
        expect(normalizeTagName('  buy   milk  ')).toBe('buy milk');
    });

    it('is a no-op on an already normalized name', () => {
        expect(normalizeTagName('buy milk')).toBe('buy milk');
    });

    it('caps the length, and does not leave a trailing space behind', () => {
        const long = `${'a'.repeat(MAX_TAG_LENGTH)} tail`;
        expect(normalizeTagName(long)).toBe('a'.repeat(MAX_TAG_LENGTH));
        const cutMidSpace = `${'a'.repeat(MAX_TAG_LENGTH - 1)} b`;
        expect(normalizeTagName(cutMidSpace)).toBe('a'.repeat(MAX_TAG_LENGTH - 1));
    });

    it('has nothing to say about nothing', () => {
        expect(normalizeTagName('')).toBe('');
        expect(normalizeTagName('   ')).toBe('');
        expect(normalizeTagName('#')).toBe('');
    });
});

const known = (...pairs: [string, number][]): TagSummary[] =>
    pairs.map(([name, documentCount]) => ({ name, documentCount }));

describe('tagPickerItems', () => {
    it('offers every tag when nothing has been typed', () => {
        const items = tagPickerItems(known(['work', 3], ['home', 1]), '');
        expect(items.map((i) => i.name)).toEqual(['work', 'home']);
        expect(items.every((i) => !i.isNew)).toBe(true);
    });

    // The list arrives ranked by how much of the corpus uses each tag, and
    // narrowing it must not throw that away.
    it('keeps the order it was given', () => {
        const items = tagPickerItems(known(['zebra', 9], ['apple', 2]), '');
        expect(items.map((i) => i.name)).toEqual(['zebra', 'apple']);
    });

    it('filters on a substring, not just a prefix', () => {
        const items = tagPickerItems(known(['reading', 1], ['work', 1]), 'ead');
        expect(items.filter((i) => !i.isNew).map((i) => i.name)).toEqual(['reading']);
    });

    it('matches regardless of the case typed', () => {
        const items = tagPickerItems(known(['work', 1]), 'WO');
        expect(items[0].name).toBe('work');
        expect(items[0].isNew).toBe(false);
    });

    it('offers to create what was typed, last', () => {
        const items = tagPickerItems(known(['working', 1]), 'work');
        expect(items.map((i) => [i.name, i.isNew])).toEqual([
            ['working', false],
            ['work', true],
        ]);
    });

    // Offering it above the matches would put "add a new tag" under the cursor
    // while the tag being reached for sat a line below, and Enter would coin a
    // duplicate.
    it('never offers to create a tag that already exists', () => {
        const items = tagPickerItems(known(['work', 4]), 'Work');
        expect(items).toHaveLength(1);
        expect(items[0].isNew).toBe(false);
    });

    it('offers nothing to create when nothing has been typed', () => {
        expect(tagPickerItems([], '')).toEqual([]);
        expect(tagPickerItems([], '  ')).toEqual([]);
    });

    it('creates the normalized name, not the keystrokes', () => {
        const [item] = tagPickerItems([], '  #Deep  Work ');
        expect(item.name).toBe('deep work');
        expect(item.title).toContain('#deep work');
    });

    it('says how much of the corpus uses each tag', () => {
        const items = tagPickerItems(known(['work', 2], ['home', 1], ['new', 0]), '');
        expect(items.map((i) => i.subtitle)).toEqual(['2 notes', '1 note', 'in this note']);
    });

    // The popup hands back an id and nothing else, so two rows that share one
    // are two rows that cannot be told apart.
    it('gives every row a distinct id', () => {
        const items = tagPickerItems(known(['working', 1]), 'work');
        expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    });
});

describe('mergeTagNames', () => {
    it('adds tags the corpus has not recorded yet', () => {
        const merged = mergeTagNames(known(['work', 2]), ['fresh']);
        expect(merged).toEqual([
            { name: 'work', documentCount: 2 },
            { name: 'fresh', documentCount: 0 },
        ]);
    });

    // A tag in the open document is usually also in the rows, and it must not
    // appear twice for it.
    it('does not duplicate a tag the corpus already knows', () => {
        const merged = mergeTagNames(known(['work', 2]), ['work']);
        expect(merged).toEqual([{ name: 'work', documentCount: 2 }]);
    });

    it('keeps the known tags first, so the ranking survives', () => {
        const merged = mergeTagNames(known(['work', 2]), ['aaa']);
        expect(merged.map((t) => t.name)).toEqual(['work', 'aaa']);
    });

    it('ignores empty names', () => {
        expect(mergeTagNames([], ['', 'ok'])).toEqual([{ name: 'ok', documentCount: 0 }]);
    });
});
