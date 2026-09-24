// What the document page shows, from the document its URL names and the one
// that is open.
//
// A rule of its own because it was wrong. With nothing open for the URL, the
// page took its document to be still on the way. That is also exactly what a
// document removed while it was open looks like, deleted here or by a paired
// device, and waiting on one of those means loading it again, which can only
// fail: it did, with an error the user had done nothing to cause.

/** What the page puts under its header. */
export type DocumentView = 'editor' | 'loading' | 'gone';

export interface DocumentViewInputs {
    /** The document the URL names. */
    routeId: string | undefined;
    /** The document that is open, if any. */
    openId: string | undefined;
    /** The last document the page had open, if it has had one. */
    shownId: string | null;
    /** Whether loading the URL's document failed. */
    loadFailed: boolean;
}

export function documentView(inputs: DocumentViewInputs): DocumentView {
    const { routeId, openId, shownId, loadFailed } = inputs;

    if (openId !== undefined) return 'editor';
    if (loadFailed) return 'gone';
    // Open for this URL a moment ago and not now, so it was removed. There is
    // nothing still to come.
    if (routeId !== undefined && routeId === shownId) return 'gone';
    return 'loading';
}
