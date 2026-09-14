import { invoke } from '@tauri-apps/api/core';

export interface SearchHit {
    id: string;
    doc_type: string;
    title: string;
    snippet: string;
}

// Long enough to coalesce typing, short enough that the results feel like they
// follow the keystrokes.
const DEBOUNCE_MS = 150;

/**
 * The state behind the sidebar's search box.
 *
 * Its own module because it is a small state machine with three things that
 * have to stay in step: a debounce, a sequence number so a slow response
 * cannot overwrite a newer one, and a selection that has to reset whenever the
 * results change. Mixed into a component with seven other concerns, each of
 * those was a separate `let` that any of the others could get wrong.
 */
export function createSearch() {
    let results = $state<SearchHit[]>([]);
    let searching = $state(false);
    // A failed search must not render as "nothing matches": that reads as an
    // answer when it is the absence of one.
    let failed = $state(false);
    // Which hit the arrow keys have moved to. Reset whenever the results
    // change, so Enter never opens a document the user cannot see highlighted.
    let selected = $state(0);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;

    async function run(query: string): Promise<void> {
        const mine = ++seq;
        try {
            const hits = await invoke<SearchHit[]>('search_documents', { query });
            // Drop a response a newer keystroke has already superseded.
            if (mine !== seq) return;
            results = hits;
            failed = false;
            selected = 0;
        } catch (err) {
            if (mine !== seq) return;
            console.error('[search] failed:', err);
            results = [];
            failed = true;
        } finally {
            if (mine === seq) searching = false;
        }
    }

    function clear(): void {
        seq++; // invalidate anything in flight
        results = [];
        failed = false;
        searching = false;
        selected = 0;
    }

    return {
        get results() {
            return results;
        },
        get searching() {
            return searching;
        },
        get failed() {
            return failed;
        },
        get selected() {
            return selected;
        },

        /**
         * Schedule a search for `query`, or clear when it is empty. Returns a
         * cancel function for the caller's effect: without it the pending
         * timer outlives the component, and a search fired after navigating
         * away writes into state nothing is rendering.
         */
        schedule(query: string): () => void {
            if (timer) clearTimeout(timer);
            if (!query) {
                clear();
                return () => {};
            }
            searching = true;
            timer = setTimeout(() => void run(query), DEBOUNCE_MS);
            return () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
        },

        /** Move the selection, wrapping. No-op with no results. */
        move(delta: number): void {
            if (results.length === 0) return;
            selected = (selected + delta + results.length) % results.length;
        },

        /** The hit the keyboard is on, if any. */
        current(): SearchHit | undefined {
            return results[selected];
        },
    };
}

export type Search = ReturnType<typeof createSearch>;
