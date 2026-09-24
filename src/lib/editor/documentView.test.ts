import { describe, it, expect } from 'vitest';
import { documentView, type DocumentViewInputs } from './documentView';

const nothingYet: DocumentViewInputs = {
    routeId: 'x',
    openId: undefined,
    shownId: null,
    loadFailed: false,
};

describe('documentView', () => {
    it('shows the editor while a document is open', () => {
        expect(documentView({ ...nothingYet, openId: 'x', shownId: 'x' })).toBe('editor');
    });

    // A deep link on a cold start: nothing is open and nothing has been, so the
    // document is on its way.
    it('waits for a document the page has not had yet', () => {
        expect(documentView(nothingYet)).toBe('loading');
    });

    // The bug: the open note was deleted, here or on a paired device, and read
    // as still to come. Waiting meant loading it again, which failed with an
    // error toast every time.
    it('says a note removed while it was open is gone, not on its way', () => {
        expect(documentView({ ...nothingYet, shownId: 'x' })).toBe('gone');
    });

    it('says a note that could not be loaded is gone', () => {
        expect(documentView({ ...nothingYet, loadFailed: true })).toBe('gone');
    });

    // Deleting the open note moves on to another one, and that one is loading,
    // whatever became of the note before it.
    it('waits for the next note after the one before it was removed', () => {
        expect(documentView({ ...nothingYet, routeId: 'y', shownId: 'x' })).toBe('loading');
    });
});
