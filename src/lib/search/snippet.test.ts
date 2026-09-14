import { describe, it, expect } from 'vitest';
import { MATCH_END, MATCH_START, snippetParts } from './snippet';

const mark = (s: string) => `${MATCH_START}${s}${MATCH_END}`;

describe('snippetParts', () => {
    it('splits a snippet around the matched run', () => {
        expect(snippetParts(`the ${mark('meeting')} notes`)).toEqual([
            { text: 'the ', match: false },
            { text: 'meeting', match: true },
            { text: ' notes', match: false },
        ]);
    });

    it('handles several matches', () => {
        expect(snippetParts(`${mark('a')} and ${mark('b')}`)).toEqual([
            { text: 'a', match: true },
            { text: ' and ', match: false },
            { text: 'b', match: true },
        ]);
    });

    it('passes through a snippet with no match markers', () => {
        expect(snippetParts('nothing marked')).toEqual([{ text: 'nothing marked', match: false }]);
    });

    it('returns nothing for an empty snippet', () => {
        expect(snippetParts('')).toEqual([]);
    });

    it('keeps the text when a marker is unpaired', () => {
        // Truncation can cut a snippet mid-match. Losing the highlight is
        // acceptable; losing the result is not.
        const parts = snippetParts(`start ${MATCH_START}unterminated`);
        expect(parts.map((p) => p.text).join('')).toContain('unterminated');
    });

    it('does not treat the note text as markup', () => {
        // Each part is rendered as text by the caller, so a note containing
        // markup stays a note containing markup.
        const parts = snippetParts(`a ${mark('<script>')} tag`);
        expect(parts[1]).toEqual({ text: '<script>', match: true });
    });
});
