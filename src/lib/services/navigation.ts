import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

// Opening a document is a navigation, so the URL says what is open, the back
// button works, and a link to a note can be followed twice.
//
// Before this it was `appStore.setCurrentDocument` called from six places,
// plus a `window.dispatchEvent('openDocument')` bus for the two that could
// not reach the store. There was no history and no deep link, and on Android
// the hardware back key exited the app from the only route there was.
export function openDocument(docId: string): Promise<void> {
    return goto(resolve('/doc/[id]', { id: docId }));
}

// Back to the entry point, which picks today's journal. Used after deleting
// whatever was open, when there is no longer a document to be on.
export function openHome(): Promise<void> {
    return goto(resolve('/'));
}
