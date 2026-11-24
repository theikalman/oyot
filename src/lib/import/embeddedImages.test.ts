import { describe, it, expect } from 'vitest';
import { contentSchema } from '$lib/editor/headlessIndex';
import { embeddedRaster, storeEmbedded } from './embeddedImages';
import { blocksOf } from '../../test/blockJson';

const schema = contentSchema();
const { doc, image, paragraph, blockquote } = schema.nodes;
const A = 'data:image/png;base64,AAAA';
const B = 'data:image/jpeg;base64,BBBB';

describe('embeddedRaster', () => {
    it('knows the pictures an attachment can be', () => {
        for (const type of ['png', 'jpeg', 'gif', 'webp']) {
            const src = `data:image/${type};base64,AAAA`;
            expect(embeddedRaster(src)).toBe(src);
        }
    });

    it('tidies one up', () => {
        expect(embeddedRaster('DATA:image/JPG;charset=x;Base64,AA\n  A%41%3D')).toBe(
            'data:image/jpeg;base64,AAAA=',
        );
    });

    it('knows nothing else', () => {
        for (const src of [
            'data:image/svg+xml;base64,AAAA',
            'data:image/png,AAAA',
            'data:image/png;base64,',
            'data:image/png;base64',
            'data:text/html;base64,AAAA',
            'https://a.b/data:image/png;base64,AAAA',
            '',
        ]) {
            expect(embeddedRaster(src), src).toBeNull();
        }
    });
});

describe('storeEmbedded', () => {
    it('stores each picture once, wherever it is', async () => {
        const saved: string[][] = [];
        const result = await storeEmbedded(
            doc.create(null, [
                image.create({ src: A, alt: 'sea', title: 't', align: 'center' }),
                blockquote.create(null, [image.create({ src: A }), image.create({ src: B })]),
                image.create({ src: 'oyot-attachment://x', alt: 'kept' }),
            ]),
            async (data, mime) => {
                saved.push([data, mime]);
                return `hash-${saved.length}`;
            },
        );
        expect(saved).toEqual([
            ['AAAA', 'image/png'],
            ['BBBB', 'image/jpeg'],
        ]);
        expect(result.failed).toBe(0);
        const [first, quote, last] = blocksOf(result.doc);
        expect(first.attrs).toMatchObject({
            src: 'oyot-attachment://hash-1',
            alt: 'sea',
            title: 't',
            align: 'center',
        });
        expect(quote.content[0].attrs).toMatchObject({
            src: 'oyot-attachment://hash-1',
            alt: 'oyot:hash-1',
        });
        expect(quote.content[1].attrs.src).toBe('oyot-attachment://hash-2');
        expect(last.attrs).toMatchObject({ src: 'oyot-attachment://x', alt: 'kept' });
    });

    it('puts its description in place of one that cannot be stored', async () => {
        const result = await storeEmbedded(
            doc.create(null, [
                image.create({ src: A, alt: 'sea' }),
                blockquote.create(null, image.create({ src: A })),
            ]),
            async () => {
                throw 'image is too large';
            },
        );
        result.doc.check();
        expect(result.failed).toBe(2);
        expect(blocksOf(result.doc)).toEqual([
            { type: 'paragraph', content: [{ type: 'text', text: 'sea' }] },
            { type: 'blockquote', content: [{ type: 'paragraph' }] },
        ]);
    });

    it('leaves a document with none as it is', async () => {
        const plain = doc.create(null, paragraph.create());
        const result = await storeEmbedded(plain, async () => 'x');
        expect(result).toEqual({ doc: plain, failed: 0 });
        expect(result.doc).toBe(plain);
    });
});
