import { describe, it, expect } from 'vitest';
import { planEdit } from './planEdit';
import { renderNote } from './noteMarkdown';
import { ctx, doc, h, HASH, image, p, t } from './testDocs';

const sized = image({
    src: `oyot-attachment://${HASH}`,
    alt: `oyot:${HASH}`,
    width: 320,
    height: 200,
});

/** A note of numbered paragraphs, `one` to `count`. */
function numbered(count: number) {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    return doc(...words.slice(0, count).map((w) => p(t(w))));
}

function rewrite(markdown: string, replace: Record<string, string>): string {
    return markdown
        .split('\n\n')
        .map((block) => replace[block.trim()] ?? block)
        .join('\n\n');
}

describe('planEdit', () => {
    it('changes nothing when the Markdown is what it was', () => {
        const note = numbered(4);
        const plan = planEdit(note, renderNote(note).markdown, ctx);
        expect(plan.hunks).toEqual([]);
        expect(plan.root.eq(note)).toBe(true);
    });

    it('changes nothing when only the spelling changes', () => {
        const note = doc(p(t('a '), t('b', [{ type: 'italic' }]), t(' c d')));
        const plan = planEdit(note, 'a _b_\nc d\n', ctx);
        expect(plan.hunks).toEqual([]);
    });

    it('inserts at the start, in the middle and at the end', () => {
        const note = numbered(3);
        for (const [markdown, from] of [
            ['zero\n\none\n\ntwo\n\nthree\n', 0],
            ['one\n\ntwo\n\nnew\n\nthree\n', 2],
            ['one\n\ntwo\n\nthree\n\nfour\n', 3],
        ] as const) {
            const plan = planEdit(note, markdown, ctx);
            expect(plan.hunks).toHaveLength(1);
            expect(plan.hunks[0]).toMatchObject({ from, to: from });
            expect(plan.hunks[0].insert.map((n) => n.textContent)).toHaveLength(1);
            expect(renderNote(plan.root).markdown).toBe(markdown);
        }
    });

    it('makes two separate edits two hunks, and keeps every block between them', () => {
        const note = numbered(10);
        const markdown = rewrite(renderNote(note).markdown, { two: 'TWO', nine: 'NINE' });
        const plan = planEdit(note, markdown, ctx);
        expect(plan.hunks.map(({ from, to }) => [from, to])).toEqual([
            [1, 2],
            [8, 9],
        ]);
        // The very nodes, not copies: nothing between the edits is touched.
        for (let i = 2; i < 8; i++) expect(plan.root.child(i)).toBe(note.child(i));
    });

    it('deletes a block', () => {
        const note = numbered(3);
        const plan = planEdit(note, 'one\n\nthree\n', ctx);
        expect(plan.hunks).toEqual([{ from: 1, to: 2, insert: [] }]);
    });

    it('gives an emptied note the one empty paragraph a note always has', () => {
        const plan = planEdit(numbered(2), '', ctx);
        expect(plan.root.toJSON().content).toEqual([p()]);
        // In the hunks too, so the content gets it, not only the plan.
        expect(plan.hunks).toEqual([{ from: 0, to: 2, insert: [plan.root.child(0)] }]);
    });

    it('keeps empty paragraphs beside blocks that stay', () => {
        const note = doc(p(t('a')), p(), p(t('b')), p(), p(t('c')));
        const plan = planEdit(note, 'a\n\nB\n\nc\n', ctx);
        expect(plan.hunks).toEqual([{ from: 2, to: 3, insert: [expect.anything()] }]);
        expect(plan.root.childCount).toBe(5);
    });

    it('drops empty paragraphs between two blocks that are both replaced', () => {
        const note = doc(p(t('a')), p(t('b')), p(), p(t('c')), p(t('d')));
        const plan = planEdit(note, 'a\n\nB\n\nC\n\nd\n', ctx);
        expect(plan.hunks).toHaveLength(1);
        expect(plan.hunks[0]).toMatchObject({ from: 1, to: 4 });
        expect(renderNote(plan.root).blocks).toEqual(['a', 'B', 'C', 'd']);
    });

    it('sees no change in a note holding the same inline image twice', () => {
        const dot = image({ src: 'data:image/png;base64,iVBORw0KGgo=', alt: null });
        const note = doc(dot, p(t('between')), dot);
        expect(renderNote(note).markdown).toBe(
            '![](oyot-inline-image://1)\n\nbetween\n\n![](oyot-inline-image://1)\n',
        );
        expect(planEdit(note, renderNote(note).markdown, ctx).hunks).toEqual([]);
    });

    describe('blocks Markdown cannot carry', () => {
        it('keeps one the edit does not touch exactly as it was', () => {
            const note = doc(p(t('a')), sized, p(t('b')));
            const plan = planEdit(note, rewrite(renderNote(note).markdown, { b: 'B' }), ctx);
            expect(plan.lossy).toEqual([]);
            expect(plan.root.child(1).attrs.width).toBe(320);
        });

        it('reports one the edit rewrites, and what it would lose', () => {
            const note = doc(p(t('a')), sized);
            const plan = planEdit(note, `a\n\n![A cat](oyot-attachment://${HASH})\n`, ctx);
            expect(plan.lossy).toEqual([
                {
                    index: 1,
                    markdown: `![](oyot-attachment://${HASH})`,
                    losses: ["an image's size"],
                },
            ]);
        });

        it('does not report one the edit deletes', () => {
            const note = doc(p(t('a')), sized);
            expect(planEdit(note, 'a\n', ctx).lossy).toEqual([]);
        });

        it('names the losses it knows of', () => {
            const table = {
                type: 'table',
                content: [
                    {
                        type: 'tableRow',
                        content: [
                            {
                                type: 'tableCell',
                                attrs: { colwidth: [120] },
                                content: [p(t('x')), p(t('y'))],
                            },
                        ],
                    },
                ],
            };
            const note = doc(table, h(1, 'z'));
            const plan = planEdit(note, '| X |\n| --- |\n\n# z\n', ctx);
            expect(plan.lossy[0].losses).toEqual([
                'a table without a header row',
                "a table's column widths",
                'more than one paragraph in a table cell',
            ]);
        });
    });
});
