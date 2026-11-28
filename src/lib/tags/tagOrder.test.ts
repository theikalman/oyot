import { describe, expect, it } from 'vitest';
import { DEFAULT_TAG_ORDER, parseTagOrder, sortTags } from './tagOrder';

const tags = [
    { name: 'work', documentCount: 3 },
    { name: 'week-10', documentCount: 1 },
    { name: 'apple', documentCount: 3 },
    { name: 'week-2', documentCount: 7 },
];

describe('sortTags', () => {
    it('lists tags alphabetically, numbers in a name read as numbers', () => {
        expect(sortTags(tags, 'name').map((t) => t.name)).toEqual([
            'apple',
            'week-2',
            'week-10',
            'work',
        ]);
    });

    it('lists the most used first, by name on a tie', () => {
        expect(sortTags(tags, 'count').map((t) => t.name)).toEqual([
            'week-2',
            'apple',
            'work',
            'week-10',
        ]);
    });

    it('leaves the input as it was', () => {
        const before = tags.map((t) => t.name);
        sortTags(tags, 'name');
        expect(tags.map((t) => t.name)).toEqual(before);
    });
});

describe('parseTagOrder', () => {
    it('defaults to alphabetical', () => {
        expect(DEFAULT_TAG_ORDER).toBe('name');
        expect(parseTagOrder(null)).toBe('name');
        expect(parseTagOrder('bogus')).toBe('name');
        expect(parseTagOrder('count')).toBe('count');
    });
});
