import { describe, it, expect } from 'vitest';
import type { ImportResult } from './importFiles';
import { describeImport } from './report';

function result(overrides: Partial<ImportResult> = {}): ImportResult {
    return { notes: [], skipped: [], imagesKeptAsText: 0, missingImages: 0, ...overrides };
}

const notes = (...titles: string[]) => titles.map((title, i) => ({ id: String(i), title }));

describe('describeImport', () => {
    it('names the note when there is one', () => {
        expect(describeImport(result({ notes: notes('Groceries') }))).toEqual({
            success: 'Imported Groceries',
            failure: null,
            warnings: [],
        });
    });

    it('counts the notes when there are several', () => {
        expect(describeImport(result({ notes: notes('a', 'b', 'c') })).success).toBe(
            'Imported 3 notes',
        );
    });

    it('says so when nothing came in', () => {
        const report = describeImport(
            result({ skipped: [{ name: 'photo.png', reason: 'not-text' }] }),
        );
        expect(report.success).toBeNull();
        expect(report.failure).toBe('No notes were imported.');
        expect(report.warnings).toEqual(['Could not import photo.png: it is not text.']);
    });

    it('names the files it skipped, grouped by why', () => {
        const report = describeImport(
            result({
                notes: notes('a'),
                skipped: [
                    { name: 'one.pdf', reason: 'not-text' },
                    { name: 'two.png', reason: 'not-text' },
                    { name: 'huge.md', reason: 'too-large' },
                ],
            }),
        );
        expect(report.warnings).toEqual([
            'Could not import one.pdf and two.png: they are not text.',
            'Could not import huge.md: it is larger than 8 MB.',
        ]);
    });

    it('names three files and counts the rest, including those with no name', () => {
        const skipped = ['a.md', 'b.md', 'c.md', 'd.md', ''].map((name) => ({
            name,
            reason: 'unreadable' as const,
        }));
        expect(describeImport(result({ skipped })).warnings).toEqual([
            'Could not import a.md, b.md, c.md and 2 more: they could not be opened.',
        ]);
        expect(
            describeImport(result({ skipped: [{ name: '', reason: 'failed' }] })).warnings,
        ).toEqual(['Could not import a file: something went wrong reading it.']);
    });

    it('counts the images that did not come in as pictures', () => {
        expect(
            describeImport(result({ notes: notes('a'), imagesKeptAsText: 2, missingImages: 1 }))
                .warnings,
        ).toEqual([
            '2 images were kept as text. Oyot cannot bring in a picture from a file beside a note, or from the web.',
            '1 image is not on this device, and will appear if a paired device has it.',
        ]);
        expect(describeImport(result({ notes: notes('a'), missingImages: 3 })).warnings).toEqual([
            '3 images are not on this device, and will appear if a paired device has them.',
        ]);
    });
});
