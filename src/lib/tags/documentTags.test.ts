import { describe, it, expect } from 'vitest';
import { NO_TAGS, tagsByDocument, tagsOf, type DocumentTagHit } from './documentTags';

function hit(documentId: string, name: string): DocumentTagHit {
    return { document_id: documentId, name };
}

describe('tagsByDocument', () => {
    it('gathers the rows of one document into one list', () => {
        const byDocument = tagsByDocument([
            hit('d1', 'admin'),
            hit('d1', 'work'),
            hit('d2', 'gym'),
        ]);

        expect(tagsOf(byDocument, 'd1')).toEqual(['admin', 'work']);
        expect(tagsOf(byDocument, 'd2')).toEqual(['gym']);
    });

    // The query's order is the order the chips are shown in, so it has to
    // survive the grouping.
    it('keeps the order the rows arrived in', () => {
        const byDocument = tagsByDocument([hit('d1', 'work'), hit('d1', 'admin')]);

        expect(tagsOf(byDocument, 'd1')).toEqual(['work', 'admin']);
    });

    it('does not need the rows of one document to be next to each other', () => {
        const byDocument = tagsByDocument([
            hit('d1', 'work'),
            hit('d2', 'gym'),
            hit('d1', 'admin'),
        ]);

        expect(tagsOf(byDocument, 'd1')).toEqual(['work', 'admin']);
    });

    it('has nothing for a document that carries no tag', () => {
        expect(tagsOf(tagsByDocument([hit('d1', 'work')]), 'd2')).toEqual([]);
        expect(tagsOf(NO_TAGS, 'd1')).toEqual([]);
    });
});
