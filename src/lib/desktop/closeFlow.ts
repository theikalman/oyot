// What the page does when the window's close button is pressed (ADR 0030).
//
// Rust cancels the native close and asks the page. The page answers at once,
// so Rust stops waiting for it, then saves what the editor has pending, shows
// the first-close notice if it is due, and tells Rust how to finish. Kept free
// of Tauri so the order can be tested.

export type CloseAction = 'hide' | 'quit' | 'default';

export interface CloseSettings {
    keepRunning: boolean;
    closeNoticeSeen: boolean;
}

export interface CloseFlowDeps {
    /** Tell Rust the request arrived. */
    acknowledge(id: number): Promise<void>;
    /** Write whatever the editor has not saved yet. */
    flushPendingSaves(): Promise<void>;
    settings(): Promise<CloseSettings>;
    /** Show the first-close notice. True for "Keep running", false for "Quit instead". */
    askKeepRunning(): Promise<boolean>;
    answerNotice(keepRunning: boolean): Promise<void>;
    finish(action: CloseAction): Promise<void>;
}

/**
 * Returns the handler for one close request, by its number.
 *
 * A second request while one is being handled, which pressing close twice
 * while the notice is up makes, is acknowledged and otherwise ignored.
 */
export function createCloseFlow(deps: CloseFlowDeps): (id: number) => Promise<void> {
    let busy = false;

    return async (id: number) => {
        // First, and always, even for a request that is about to be ignored:
        // Rust closes without the page once it has waited long enough, and a
        // page that is merely busy should not be closed over.
        await deps
            .acknowledge(id)
            .catch((e) => console.warn('[close] could not acknowledge a close request:', e));
        if (busy) return;
        busy = true;
        try {
            await deps.flushPendingSaves();

            let settings: CloseSettings;
            try {
                settings = await deps.settings();
            } catch (e) {
                console.warn('[close] could not read the close settings, using them as set:', e);
                await deps.finish('default');
                return;
            }

            if (settings.keepRunning && !settings.closeNoticeSeen) {
                const keepRunning = await deps.askKeepRunning();
                await deps
                    .answerNotice(keepRunning)
                    .catch((e) => console.warn('[close] could not save the answer:', e));
                await deps.finish(keepRunning ? 'hide' : 'quit');
            } else {
                await deps.finish('default');
            }
        } finally {
            busy = false;
        }
    };
}
