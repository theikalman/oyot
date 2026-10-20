import { describe, it, expect } from 'vitest';
import { fitWithin, MAX_EDGE, prepareImage, type Codec, type Decoded } from './images';

/**
 * A codec that knows each image's size from a table rather than its bytes,
 * and encodes to as many bytes as a table says for the type and quality.
 */
function fakeCodec(
    decoded: Decoded,
    sizes: (mime: string, quality: number) => number,
): {
    codec: Codec;
    encodes: [string, number, number, number][];
} {
    const encodes: [string, number, number, number][] = [];
    return {
        encodes,
        codec: {
            async decode() {
                return decoded;
            },
            async encode(_bytes, _mime, width, height, outMime, quality) {
                encodes.push([outMime, quality, width, height]);
                return new Uint8Array(sizes(outMime, quality));
            },
        },
    };
}

const opaque = (width: number, height: number): Decoded => ({
    width,
    height,
    hasAlpha: false,
    animated: false,
});

describe('prepareImage', () => {
    it('sends a small image of a type Claude reads as it is', async () => {
        const bytes = new Uint8Array(1000);
        const { codec, encodes } = fakeCodec(opaque(800, 600), () => 0);
        const result = await prepareImage(bytes, 'image/png', 700_000, codec);
        expect(result).toEqual({
            ok: true,
            image: {
                bytes,
                mime: 'image/png',
                width: 800,
                height: 600,
                scaled: false,
                firstFrameOnly: false,
            },
        });
        expect(encodes).toEqual([]);
    });

    it('scales one too large in pixels to the long edge, keeping its shape', async () => {
        const { codec, encodes } = fakeCodec(opaque(4032, 3024), () => 300_000);
        const result = await prepareImage(new Uint8Array(1000), 'image/jpeg', 700_000, codec);
        expect(result.ok && result.image).toMatchObject({
            mime: 'image/jpeg',
            width: MAX_EDGE,
            height: 1176,
            scaled: true,
        });
        expect(encodes).toEqual([['image/jpeg', 0.85, MAX_EDGE, 1176]]);
    });

    it('steps the quality down until one too large in bytes fits', async () => {
        const { codec, encodes } = fakeCodec(opaque(1200, 900), (_m, q) =>
            q > 0.6 ? 900_000 : 500_000,
        );
        const result = await prepareImage(new Uint8Array(2_000_000), 'image/jpeg', 700_000, codec);
        expect(result.ok && result.image.bytes.length).toBe(500_000);
        expect(encodes.map(([, q]) => q)).toEqual([0.85, 0.7, 0.55]);
    });

    it('keeps transparency as PNG, and falls back to JPEG only if PNG will not fit', async () => {
        const clear = { ...opaque(3000, 1000), hasAlpha: true };
        const fits = fakeCodec(clear, () => 400_000);
        const kept = await prepareImage(new Uint8Array(10), 'image/png', 700_000, fits.codec);
        expect(kept.ok && kept.image.mime).toBe('image/png');

        const big = fakeCodec(clear, (m) => (m === 'image/png' ? 2_000_000 : 400_000));
        const fallback = await prepareImage(new Uint8Array(10), 'image/png', 700_000, big.codec);
        expect(fallback.ok && fallback.image.mime).toBe('image/jpeg');
        expect(big.encodes.map(([m]) => m)).toEqual(['image/png', 'image/jpeg']);
    });

    it("says when only an animation's first frame was kept", async () => {
        const { codec } = fakeCodec({ ...opaque(2000, 2000), animated: true }, () => 100);
        const result = await prepareImage(new Uint8Array(10), 'image/gif', 700_000, codec);
        expect(result.ok && result.image.firstFrameOnly).toBe(true);
    });

    it('redraws an image of a type Claude does not read as one it does', async () => {
        const { codec } = fakeCodec(opaque(100, 100), () => 100);
        const result = await prepareImage(new Uint8Array(10), 'image/bmp', 700_000, codec);
        expect(result.ok && result.image).toMatchObject({ mime: 'image/jpeg', scaled: true });
    });

    it('refuses what cannot be decoded, and what cannot be made to fit', async () => {
        const broken: Codec = {
            decode: () => Promise.reject(new Error('not an image')),
            encode: () => Promise.reject(new Error('unreachable')),
        };
        expect(await prepareImage(new Uint8Array(10), 'image/svg+xml', 700_000, broken)).toEqual({
            ok: false,
            reason: 'unsupported_type',
        });
        const { codec } = fakeCodec(opaque(5000, 5000), () => 5_000_000);
        expect(await prepareImage(new Uint8Array(10), 'image/jpeg', 700_000, codec)).toEqual({
            ok: false,
            reason: 'too_large',
        });
    });
});

describe('fitWithin', () => {
    it('leaves what fits, and scales what does not by its long side', () => {
        expect(fitWithin(1568, 10, 1568)).toEqual([1568, 10]);
        expect(fitWithin(1000, 3136, 1568)).toEqual([500, 1568]);
        expect(fitWithin(10_000, 1, 1568)).toEqual([1568, 1]);
    });
});
