import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { createContentExtensions } from '$lib/editor/extensions';
import { altFor, alignOf, describedAlt, storedAlign } from './imageAttrs';

const HASH = 'a'.repeat(64);
const SRC = `oyot-attachment://${HASH}`;

describe('storedAlign', () => {
    it('keeps center and right', () => {
        expect(storedAlign('center')).toBe('center');
        expect(storedAlign('right')).toBe('right');
    });

    it('stores left, and anything that is not an alignment, as null', () => {
        expect(storedAlign('left')).toBeNull();
        expect(storedAlign(null)).toBeNull();
        expect(storedAlign('middle')).toBeNull();
        expect(storedAlign(3)).toBeNull();
    });

    it('reads a missing alignment as left', () => {
        expect(alignOf(null)).toBe('left');
        expect(alignOf('right')).toBe('right');
    });
});

describe('describedAlt', () => {
    it('hides the bookkeeping the editor keeps in alt', () => {
        expect(describedAlt(`oyot:${HASH}`)).toBe('');
        expect(describedAlt(null)).toBe('');
    });

    it('keeps a real description', () => {
        expect(describedAlt('A cat on a mat')).toBe('A cat on a mat');
    });
});

describe('altFor', () => {
    it('stores a description in place of the bookkeeping', () => {
        expect(altFor(SRC, `oyot:${HASH}`, '  A cat\n on a mat ')).toBe('A cat on a mat');
    });

    it('gives an attachment its hash back when the description is cleared', () => {
        expect(altFor(SRC, 'A cat', '   ')).toBe(`oyot:${HASH}`);
    });

    it('gives an inline image no alt when the description is cleared', () => {
        expect(altFor('data:image/png;base64,AAAA', 'A cat', '')).toBeNull();
    });
});

describe('the image schema', () => {
    const schema = getSchema(createContentExtensions());

    it('has an align attribute that defaults to null', () => {
        const image = schema.nodes.image.create({ src: SRC });
        expect(image.attrs.align).toBeNull();
    });

    it('keeps the alignment through the collaboration binding', () => {
        const json = {
            type: 'doc',
            content: [{ type: 'image', attrs: { src: SRC, alt: 'A cat', align: 'center' } }],
        };
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment('content');
        prosemirrorJSONToYXmlFragment(schema, json, fragment);
        const back = yXmlFragmentToProseMirrorRootNode(fragment, schema);
        expect(back.firstChild?.attrs.align).toBe('center');
        expect(back.firstChild?.attrs.alt).toBe('A cat');
    });
});
