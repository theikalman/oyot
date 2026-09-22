import { describe, it, expect } from 'vitest';
import { assignNoteNames, slugify } from './filenames';

describe('slugify', () => {
    it('reduces a title to hyphenated words', () => {
        expect(slugify('Trip to Kyoto')).toBe('trip-to-kyoto');
        expect(slugify('22 Sep 2026')).toBe('22-sep-2026');
    });

    it('strips what a filesystem or a shell would argue about', () => {
        expect(slugify('Q3: revenue/costs?')).toBe('q3-revenue-costs');
        expect(slugify('a\\b*c|d')).toBe('a-b-c-d');
        expect(slugify('#tagged $money')).toBe('tagged-money');
    });

    it('keeps letters outside ASCII', () => {
        expect(slugify('Café notes')).toBe('café-notes');
        expect(slugify('日記')).toBe('日記');
    });

    it('collapses the runs a strip leaves behind', () => {
        expect(slugify('  ...spaced   out...  ')).toBe('spaced-out');
    });

    it('caps the length without leaving a trailing hyphen', () => {
        const slug = slugify(`${'a'.repeat(59)} tail`);
        expect(slug.length).toBeLessThanOrEqual(60);
        expect(slug.endsWith('-')).toBe(false);
    });

    it('returns nothing for a title with nothing in it', () => {
        expect(slugify('')).toBe('');
        expect(slugify('***')).toBe('');
    });
});

describe('assignNoteNames', () => {
    it('names each note after its title', () => {
        const names = assignNoteNames([
            { id: '1', title: 'Groceries' },
            { id: '2', title: 'Trip to Kyoto' },
        ]);
        expect(names.get('1')).toBe('groceries.md');
        expect(names.get('2')).toBe('trip-to-kyoto.md');
    });

    // Two notes called "Ideas" is the normal case, not an edge case.
    it('suffixes a collision rather than overwriting it', () => {
        const names = assignNoteNames([
            { id: '1', title: 'Ideas' },
            { id: '2', title: 'Ideas' },
            { id: '3', title: 'ideas' },
        ]);
        expect(names.get('1')).toBe('ideas.md');
        expect(names.get('2')).toBe('ideas-2.md');
        expect(names.get('3')).toBe('ideas-3.md');
    });

    it('falls back for a title that slugs to nothing', () => {
        const names = assignNoteNames([
            { id: '1', title: '' },
            { id: '2', title: '???' },
        ]);
        expect(names.get('1')).toBe('untitled.md');
        expect(names.get('2')).toBe('untitled-2.md');
    });

    // The archive is extracted on whatever machine the user has, and Windows
    // refuses these names whatever extension follows them.
    it('avoids the names Windows reserves', () => {
        const names = assignNoteNames([
            { id: '1', title: 'CON' },
            { id: '2', title: 'aux' },
        ]);
        expect(names.get('1')).toBe('con-note.md');
        expect(names.get('2')).toBe('aux-note.md');
    });

    it('gives every document a name', () => {
        const docs = Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: 'Same' }));
        const names = assignNoteNames(docs);
        expect(names.size).toBe(50);
        expect(new Set(names.values()).size).toBe(50);
    });
});
