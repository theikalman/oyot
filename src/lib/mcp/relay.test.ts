import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const { handleMcpRequest, parseDataUri } = await import('./relay');
const { doc, fakeDeps, HASH, image, p, t, ydocOf } = await import('./testDocs');
type Codec = import('./images').Codec;

const DOT = 'data:image/png;base64,iVBORw0KGgo=';

function depsFor(ydoc: Y.Doc, codec?: Partial<Codec>) {
    const { deps } = fakeDeps(new Map([['n1', ydoc]]));
    return { ...deps, codec: { ...deps.codec, ...codec } };
}

describe('handleMcpRequest', () => {
    const note = ydocOf(
        doc(
            p(t('see the cat')),
            image({ src: `oyot-attachment://${HASH}`, alt: 'A cat' }),
            image({ src: DOT, alt: null }),
        ),
    );

    it('renders a note with its revision and images', async () => {
        const read = (await handleMcpRequest('readNote', { docId: 'n1' }, depsFor(note))) as {
            markdown: string;
            revision: string;
            images: unknown[];
        };
        expect(read.markdown).toBe(
            `see the cat\n\n![A cat](oyot-attachment://${HASH})\n\n![](oyot-inline-image://1)\n`,
        );
        expect(read.revision).toMatch(/^[0-9a-f]{64}$/);
        expect(read.images).toEqual([
            { ref: HASH, kind: 'attachment', alt: 'A cat' },
            { ref: '1', kind: 'inline', alt: null },
        ]);
    });

    it('gives an inline image by its id, and refuses one the note does not have', async () => {
        expect(
            await handleMcpRequest('inlineImage', { docId: 'n1', id: '1' }, depsFor(note)),
        ).toEqual({
            mime: 'image/png',
            base64: 'iVBORw0KGgo=',
        });
        await expect(
            handleMcpRequest('inlineImage', { docId: 'n1', id: '2' }, depsFor(note)),
        ).rejects.toThrow('no inline image 2');
    });

    it('redraws an image to fit, and says why when it cannot', async () => {
        const drawn = await handleMcpRequest(
            'prepareImage',
            { mime: 'image/png', base64: 'AAAA', maxBytes: 700_000 },
            depsFor(note),
        );
        expect(drawn).toEqual({
            ok: true,
            mime: 'image/jpeg',
            base64: 'AQID',
            width: 1568,
            height: 1045,
            scaled: true,
            firstFrameOnly: false,
        });

        const broken = await handleMcpRequest(
            'prepareImage',
            { mime: 'image/png', base64: 'AAAA', maxBytes: 700_000 },
            depsFor(note, { decode: () => Promise.reject(new Error('bad')) }),
        );
        expect(broken).toEqual({ ok: false, reason: 'unsupported_type' });
    });

    it('refuses what it does not know', async () => {
        await expect(handleMcpRequest('deleteNote', {}, depsFor(note))).rejects.toThrow(
            'does not know how to deleteNote',
        );
        await expect(handleMcpRequest('readNote', {}, depsFor(note))).rejects.toThrow(
            'docId is missing',
        );
    });
});

describe('parseDataUri', () => {
    it('takes base64 as it is, and encodes text that is not', () => {
        expect(parseDataUri('data:image/gif;base64,R0lG')).toEqual({
            mime: 'image/gif',
            base64: 'R0lG',
        });
        expect(parseDataUri('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')).toEqual({
            mime: 'image/svg+xml',
            base64: btoa('<svg/>'),
        });
        expect(() => parseDataUri('https://example.com/a.png')).toThrow();
    });
});
