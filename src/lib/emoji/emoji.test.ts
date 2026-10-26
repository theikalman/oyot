import { describe, it, expect } from 'vitest';
import { buildEmojiList, loadEmoji, emojiForShortcode, searchEmoji, type Emoji } from './emoji';

function emoji(name: string, shortcodes: string[], tags: string[] = []): Emoji {
    return { emoji: name, hexcode: name, name, shortcodes, tags };
}

describe('buildEmojiList', () => {
    it('leaves out skin tones and lone regional indicators', () => {
        const list = buildEmojiList(
            [
                { hexcode: '1F1E6', label: 'regional indicator A', unicode: '🇦' },
                { hexcode: '1F3FB', label: 'light skin tone', unicode: '🏻', group: 2 },
                { hexcode: '1F600', label: 'grinning face', unicode: '😀', group: 0 },
            ],
            {},
        );
        expect(list.map((e) => e.emoji)).toEqual(['😀']);
    });

    it('takes one shortcode or several', () => {
        const list = buildEmojiList(
            [
                { hexcode: 'A', label: 'Thumbs Up', unicode: '👍', group: 1, tags: ['yes'] },
                { hexcode: 'B', label: 'party popper', unicode: '🎉', group: 6 },
            ],
            { A: ['+1', 'thumbsup'], B: 'tada' },
        );
        expect(list[0]).toEqual({
            emoji: '👍',
            hexcode: 'A',
            name: 'thumbs up',
            shortcodes: ['+1', 'thumbsup'],
            tags: ['yes'],
        });
        expect(list[1].shortcodes).toEqual(['tada']);
    });
});

describe('searchEmoji', () => {
    const list = [
        emoji('grinning face', ['grinning']),
        emoji('smiling face with smiling eyes', ['blush']),
        emoji('grinning face with smiling eyes', ['smile']),
        emoji('thumbs up', ['+1', 'thumbsup'], ['like', 'yes']),
        emoji('party popper', ['tada'], ['celebration']),
    ];
    const names = (q: string) => searchEmoji(list, q).map((e) => e.name);

    it('puts the exact shortcode first', () => {
        expect(names('smile')[0]).toBe('grinning face with smiling eyes');
    });

    it('ranks a shortcode above a word of the name, and keeps the order within a rank', () => {
        expect(names('smil')).toEqual([
            'grinning face with smiling eyes',
            'smiling face with smiling eyes',
        ]);
    });

    it('finds by a word of the name and by a tag', () => {
        expect(names('party')).toEqual(['party popper']);
        expect(names('celeb')).toEqual(['party popper']);
        expect(names('like')).toEqual(['thumbs up']);
    });

    it('reads a shortcode with its colons', () => {
        expect(names(':+1:')).toEqual(['thumbs up']);
    });

    it('is the start of the list for nothing typed, up to the limit', () => {
        expect(searchEmoji(list, '', 2).map((e) => e.name)).toEqual([
            'grinning face',
            'smiling face with smiling eyes',
        ]);
    });

    it('is empty when nothing matches', () => {
        expect(names('-)')).toEqual([]);
    });
});

describe('the bundled data', () => {
    it('loads, and knows the shortcodes people type', async () => {
        const list = await loadEmoji();
        expect(list.length).toBeGreaterThan(1500);
        expect(emojiForShortcode('tada')?.emoji).toBe('🎉');
        expect(emojiForShortcode('+1')?.name).toBe('thumbs up');
        expect(searchEmoji(list, 'heart')[0].shortcodes).toContain('heart');
    });
});
