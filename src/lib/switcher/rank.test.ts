import { describe, expect, it } from 'vitest';
import { highlight, matchScore, rank } from './rank';

describe('matchScore', () => {
    it('needs every word typed', () => {
        expect(matchScore('Nixiza - Development', 'nixi dev')).toBeGreaterThan(0);
        expect(matchScore('Nixiza - Development', 'nixi oman')).toBe(0);
        expect(matchScore('anything', '   ')).toBe(0);
    });

    it('puts a title that starts with the words ahead of one that only has them', () => {
        expect(matchScore('Nixiza', 'nix')).toBeGreaterThan(matchScore('Phoenix', 'nix'));
        expect(matchScore('ninjaOne - Onboarding', 'onb')).toBeGreaterThan(
            matchScore('Monboard', 'onb'),
        );
    });
});

describe('rank', () => {
    const titles = ['Nixiza - Development', 'Daily Tought', 'Nixiza', 'Phoenix notes'];

    it('lists the best matches first, up to the limit', () => {
        expect(rank(titles, 'nix', (t) => t, 2)).toEqual(['Nixiza', 'Nixiza - Development']);
    });

    it('leaves out what does not match', () => {
        expect(rank(titles, 'zzz', (t) => t, 10)).toEqual([]);
    });
});

describe('highlight', () => {
    it('marks the matched letters', () => {
        expect(highlight('Nixiza', 'nixi')).toEqual([
            { text: 'Nixi', match: true },
            { text: 'za', match: false },
        ]);
    });
});
