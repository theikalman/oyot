import type { ImportResult } from './importFiles';
import { runMarkdownImport } from './importNotes';

/**
 * The one import that can run at a time, and how far it has got.
 *
 * Module state rather than a page's: two pages start an import, the Notes
 * page and Settings, and either can be left and come back to while one runs.
 * Each has to show the same busy button, and neither may start a second.
 */
function createMarkdownImport() {
    let running = $state(false);
    let done = $state(0);
    let total = $state(0);

    return {
        get running() {
            return running;
        },

        /** What the Import button says. */
        get label() {
            if (!running) return 'Import';
            return total > 1 ? `Importing ${done} of ${total}…` : 'Importing…';
        },

        /**
         * Let the user pick files and import them, unless an import is
         * already running. Resolves to the result for the page to act on, or
         * null when there is none: nothing was picked, the import failed and
         * has said so, or one was already running.
         */
        async start(): Promise<ImportResult | null> {
            if (running) return null;
            running = true;
            done = 0;
            total = 0;
            try {
                return await runMarkdownImport((doneNow, totalNow) => {
                    done = doneNow;
                    total = totalNow;
                });
            } finally {
                running = false;
            }
        },
    };
}

export const markdownImport = createMarkdownImport();
