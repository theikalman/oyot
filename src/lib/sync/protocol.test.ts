import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from './protocol';

describe('base64', () => {
    it('round-trips arbitrary bytes', () => {
        for (const n of [0, 1, 2, 255, 4096, 100_000]) {
            const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
            expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
        }
    });
});
