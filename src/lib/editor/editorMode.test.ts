import { beforeEach, describe, expect, it } from 'vitest';
import { openNextForEditing, opensForEditing } from './editorMode';

describe('opensForEditing', () => {
    // The request is module state; asking about anything clears it.
    beforeEach(() => {
        opensForEditing('');
    });

    it('opens a document for reading', () => {
        expect(opensForEditing('a')).toBe(false);
    });

    it('opens a note just created for editing', () => {
        openNextForEditing('a');

        expect(opensForEditing('a')).toBe(true);
    });

    // Going back to it later, or reloading it, is an ordinary open.
    it('opens it for reading after that', () => {
        openNextForEditing('a');
        opensForEditing('a');

        expect(opensForEditing('a')).toBe(false);
    });

    it('does not open some other document for editing', () => {
        openNextForEditing('a');

        expect(opensForEditing('b')).toBe(false);
    });

    // The navigation to the new note went elsewhere, and the note is reached
    // later by some ordinary way in.
    it('forgets the request once another document has been opened', () => {
        openNextForEditing('a');
        opensForEditing('b');

        expect(opensForEditing('a')).toBe(false);
    });

    it('keeps only the latest request', () => {
        openNextForEditing('a');
        openNextForEditing('b');

        expect(opensForEditing('b')).toBe(true);
    });
});
