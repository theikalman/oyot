import { describe, it, expect } from 'vitest';
import { ATTACHMENT_SCHEME, attachmentHash, isLegacyBakedSrc } from './attachmentRef';

const HASH = 'ab'.repeat(32);
const baked = `http://asset.localhost/data/attachments/${HASH}.png`;

// What an image's attributes may hold instead of text.
const WRONG: unknown[] = [[HASH], { a: 1 }, { toString: 'x' }, 7, true, null, undefined];

describe('attachmentHash', () => {
    it('reads the hash from every form a document may hold', () => {
        expect(attachmentHash(`${ATTACHMENT_SCHEME}${HASH.toUpperCase()}`)).toBe(HASH);
        expect(attachmentHash('anything', `oyot:${HASH}`)).toBe(HASH);
        expect(attachmentHash(baked)).toBe(HASH);
    });

    it('reads none from what holds none', () => {
        expect(attachmentHash('https://a.example/b.png', 'A picture')).toBeNull();
        expect(attachmentHash('', '')).toBeNull();
        expect(attachmentHash(ATTACHMENT_SCHEME)).toBeNull();
    });

    it('reads none from what is not text', () => {
        for (const src of WRONG) {
            for (const alt of WRONG) expect(attachmentHash(src, alt)).toBeNull();
        }
    });

    it('reads the one that is text beside one that is not', () => {
        for (const wrong of WRONG) {
            expect(attachmentHash(`${ATTACHMENT_SCHEME}${HASH}`, wrong)).toBe(HASH);
            expect(attachmentHash(baked, wrong)).toBe(HASH);
            expect(attachmentHash(wrong, `oyot:${HASH}`)).toBe(HASH);
        }
    });
});

describe('isLegacyBakedSrc', () => {
    it('is a path that is neither the scheme nor inline', () => {
        expect(isLegacyBakedSrc(baked)).toBe(true);
        expect(isLegacyBakedSrc(`${ATTACHMENT_SCHEME}${HASH}`)).toBe(false);
        expect(isLegacyBakedSrc('data:image/png;base64,AA==')).toBe(false);
        expect(isLegacyBakedSrc('')).toBe(false);
    });

    it('is not what is not text', () => {
        for (const src of WRONG) expect(isLegacyBakedSrc(src)).toBe(false);
    });
});
