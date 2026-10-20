import { describe, it, expect } from 'vitest';
import { parseNote, renderBlock, renderNote, revisionOf } from './noteMarkdown';
import { ctx, doc, h, HASH, image, p, t } from './testDocs';

const DATA_URI =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('renderNote', () => {
    it('writes links to notes and attachments under Oyot addresses', () => {
        const note = doc(
            p(t('see '), { type: 'documentLink', attrs: { targetId: 'n1', title: 'Kyoto trip' } }),
            image({ src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}` }),
        );
        expect(renderNote(note).markdown).toBe(
            `see [Kyoto trip](oyot://note/n1)\n\n![](oyot-attachment://${HASH})\n`,
        );
    });

    it('writes an inline image under an address of its own, not its base64', () => {
        const note = doc(p(t('a')), image({ src: DATA_URI, alt: 'a dot' }), p(t('b')));
        const rendered = renderNote(note);
        expect(rendered.markdown).toBe('a\n\n![a dot](oyot-inline-image://1)\n\nb\n');
        expect(rendered.markdown).not.toContain('base64');
        expect(rendered.inlineImages.get('1')).toBe(DATA_URI);
    });

    it("lists every image in document order, without the editor's bookkeeping", () => {
        const note = doc(
            image({ src: `oyot-attachment://${HASH}`, alt: `oyot:${HASH}` }),
            { type: 'blockquote', content: [image({ src: DATA_URI, alt: null })] },
            image({ src: `oyot-attachment://${'b'.repeat(64)}`, alt: 'A cat' }),
        );
        expect(renderNote(note).images).toEqual([
            { ref: HASH, kind: 'attachment', alt: null },
            { ref: '1', kind: 'inline', alt: null },
            { ref: 'b'.repeat(64), kind: 'attachment', alt: 'A cat' },
        ]);
    });

    it('gives one block entry per top-level block, an empty paragraph as nothing', () => {
        const note = doc(h(1, 'Plan'), p(), p(t('go')));
        const rendered = renderNote(note);
        expect(rendered.blocks).toEqual(['# Plan', '', 'go']);
        expect(rendered.markdown).toBe('# Plan\n\ngo\n');
    });

    it('renders each block as renderBlock does', () => {
        const note = doc(h(2, 'a'), image({ src: DATA_URI, alt: null }), p(t('b')));
        const rendered = renderNote(note);
        note.forEach((child, _offset, index) => {
            expect(renderBlock(child, rendered.inlineImages)).toBe(rendered.blocks[index]);
        });
    });
});

describe('parseNote', () => {
    it('reads what renderNote wrote back into the same note', () => {
        const note = doc(
            h(1, 'Trip'),
            p(t('pack for '), { type: 'tag', attrs: { name: 'house move' } }),
            p(t('see '), { type: 'documentLink', attrs: { targetId: 'n1', title: 'Kyoto trip' } }),
            image({ src: DATA_URI, alt: 'a dot' }),
        );
        const rendered = renderNote(note);
        expect(parseNote(rendered.markdown, ctx, rendered.inlineImages).toJSON()).toEqual(
            note.toJSON(),
        );
    });

    it('keeps an inline image id it was not given as the text it is', () => {
        const back = parseNote('![x](oyot-inline-image://9)', ctx);
        expect(back.toJSON().content).toEqual([p(t('![x](oyot-inline-image://9)'))]);
    });

    it('leaves a link to a note that does not exist a plain link', () => {
        const back = parseNote('[gone](oyot://note/zz)', ctx);
        expect(back.firstChild?.firstChild?.marks[0]?.type.name).toBe('link');
    });
});

describe('revisionOf', () => {
    it('is the hex SHA-256 of the Markdown', async () => {
        // echo -n 'abc' | sha256sum
        expect(await revisionOf('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
        expect(await revisionOf('abd')).not.toBe(await revisionOf('abc'));
    });
});
