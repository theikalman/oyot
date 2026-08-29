import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { bytesToBase64, base64ToBytes } from './protocol';
import { contentHashBase64 } from './hash';

describe('base64', () => {
    it('round-trips arbitrary bytes', () => {
        for (const n of [0, 1, 2, 255, 4096, 100_000]) {
            const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
            expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
        }
    });
});

describe('contentHash', () => {
    it('is stable and matches for equal Yjs state produced independently', async () => {
        const a = new Y.Doc();
        a.getText('t').insert(0, 'hello world');
        const b = new Y.Doc();
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

        const ha = await contentHashBase64(Y.encodeStateAsUpdate(a));
        const hb = await contentHashBase64(Y.encodeStateAsUpdate(b));
        expect(ha).toBe(hb);
    });

    it('differs when the content differs', async () => {
        const a = new Y.Doc();
        a.getText('t').insert(0, 'one');
        const b = new Y.Doc();
        b.getText('t').insert(0, 'two');
        expect(await contentHashBase64(Y.encodeStateAsUpdate(a))).not.toBe(
            await contentHashBase64(Y.encodeStateAsUpdate(b)),
        );
    });
});
