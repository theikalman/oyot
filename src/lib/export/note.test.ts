import { describe, it, expect } from 'vitest';
import { renderNote } from './note';

const meta = {
    id: 'doc-1',
    title: 'Groceries',
    docType: 'note',
    createdAt: Date.UTC(2026, 8, 20, 9, 30),
    updatedAt: Date.UTC(2026, 8, 22, 11, 0),
    tags: ['shopping', 'house move'],
};

describe('renderNote', () => {
    it('writes front matter, a heading and the body', () => {
        expect(renderNote(meta, '-   [ ] milk\n')).toBe(
            [
                '---',
                'id: "doc-1"',
                'title: "Groceries"',
                'type: "note"',
                'created: "2026-09-20T09:30:00.000Z"',
                'updated: "2026-09-22T11:00:00.000Z"',
                'tags: ["shopping", "house move"]',
                '---',
                '',
                '# Groceries',
                '',
                '-   [ ] milk',
                '',
            ].join('\n'),
        );
    });

    it('leaves out tags when there are none', () => {
        expect(renderNote({ ...meta, tags: [] }, 'body')).not.toContain('tags:');
    });

    // A title is free text, and unquoted YAML would read several of these as
    // something other than a string.
    it('quotes and escapes a title whatever it says', () => {
        const rendered = renderNote({ ...meta, title: 'He said "no": true' }, '');
        expect(rendered).toContain('title: "He said \\"no\\": true"');
    });

    it('names an untitled note in the heading', () => {
        expect(renderNote({ ...meta, title: '' }, '')).toContain('# Untitled');
    });

    it('still produces a file for a note with no content', () => {
        const rendered = renderNote(meta, '');
        expect(rendered.endsWith('# Groceries\n')).toBe(true);
    });

    // A clock that was wrong when the row was written should not take the
    // whole export down with it.
    it('leaves out a date that is not one', () => {
        const rendered = renderNote({ ...meta, createdAt: Number.NaN }, '');
        expect(rendered).not.toContain('created:');
        expect(rendered).toContain('updated:');
    });
});
