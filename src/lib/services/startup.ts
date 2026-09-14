import { appStore } from '$lib/stores/app';
import { initializeTheme } from './theme';
import { loadAllDocuments, reindexAndCollect } from './documents';

// Everything the app has to do once, and a way to wait for it.
//
// The layout starts it and the entry route waits for it. Both need the
// document list: the layout to render the sidebar, the entry route to fall
// back to some other document when today's journal cannot be opened. Running
// them concurrently let a late `setDocuments` replace the list a just-created
// journal had already been added to.
//
// Memoised rather than guarded by a boolean, so a second caller gets the same
// promise and waits for the same work instead of starting its own.
let started: Promise<void> | null = null;

async function run(): Promise<void> {
    try {
        appStore.setTheme(await initializeTheme());
    } catch (error) {
        console.error('Failed to load theme:', error);
    }

    appStore.setLoading(true);
    try {
        const indexData = await loadAllDocuments();
        appStore.setDocuments(indexData.documents);
    } catch (error) {
        // loadAllDocuments already reports its own failure to the user.
        console.error('Failed to load documents:', error);
    } finally {
        appStore.setLoading(false);
    }

    // Deliberately not awaited: it builds any missing search index and then
    // collects unreferenced images, which on a large corpus is slow and is
    // nothing the first screen depends on.
    void reindexAndCollect().catch((error) => {
        console.error('Background maintenance failed:', error);
    });
}

/** Begin startup, or return the run already in progress. */
export function startApp(): Promise<void> {
    started ??= run();
    return started;
}
