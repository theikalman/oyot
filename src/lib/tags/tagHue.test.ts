import { describe, expect, it } from 'vitest';
import { TAG_HUES, tagHue, tagHueStyle } from './tagHue';

describe('tagHue', () => {
    it('gives a tag the same hue every time, whatever its case', () => {
        expect(tagHue('work')).toBe(tagHue('work'));
        expect(tagHue('Work')).toBe(tagHue('work'));
    });

    it('stays within the scheme’s hues', () => {
        for (const name of ['a', 'work', 'ninjaone', 'oyot', 'universitasterbuka', '日本']) {
            const hue = tagHue(name);
            expect(hue).toBeGreaterThanOrEqual(1);
            expect(hue).toBeLessThanOrEqual(TAG_HUES);
        }
    });

    it('spreads common tags over more than one hue', () => {
        const hues = new Set(['work', 'ninjaone', 'oyot', 'blog', 'nixiza', 'ideas'].map(tagHue));
        expect(hues.size).toBeGreaterThan(2);
    });

    it('names the variable the pill reads', () => {
        expect(tagHueStyle('work')).toBe(`--tag-hue: var(--tag-${tagHue('work')})`);
    });
});
