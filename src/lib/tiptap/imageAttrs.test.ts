import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { createContentExtensions } from '$lib/editor/extensions';
import { alignOf, storedAlign } from './imageAttrs';

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
