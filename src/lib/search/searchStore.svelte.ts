import { invoke } from '@tauri-apps/api/core';
import type { SearchHit } from './results';
import type { DocumentType } from './scopes';

export type { SearchHit };

// Long enough to coalesce typing, short enough that the results feel like they
// follow the keystrokes.
const DEBOUNCE_MS = 150;

/**
 * How many hits a search shows. One more is asked for, which is how the page
 * knows there are more than it is showing and can say so, rather than call
 * the first hundred everything.
 */
export const SHOWN_HITS = 100;

/**
 * The state behind a full-text search box.
 *
 * Its own module because it is a small state machine with three things that
 * have to stay in step: a debounce, a sequence number so a slow response
 * cannot overwrite a newer one, and a selection that has to reset whenever the
 * results change. Mixed into a component with seven other concerns, each of
 * those was a separate `let` that any of the others could get wrong.
 */
export function createSearch() {
    let results = $state<SearchHit[]>([]);
    // Whether the index found more than `results` holds.
    let more = $state(false);
    let searching = $state(false);
    // A failed search must not render as "nothing matches": that reads as an
    // answer when it is the absence of one.
    let failed = $state(false);
    // Which hit the arrow keys have moved to. Reset whenever the results
    // change, so Enter never opens a document the user cannot see highlighted.
    let selected = $state(0);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;

    async function run(query: string, docType: DocumentType | null): Promise<void> {
        const mine = ++seq;
        try {
            const hits = await invoke<SearchHit[]>('search_documents', {
                query,
                docType,
                limit: SHOWN_HITS + 1,
            });
            // Drop a response a newer keystroke has already superseded.
            if (mine !== seq) return;
            results = hits.slice(0, SHOWN_HITS);
            more = hits.length > SHOWN_HITS;
            failed = false;
            selected = 0;
        } catch (err) {
            if (mine !== seq) return;
            console.error('[search] failed:', err);
            results = [];
            more = false;
            failed = true;
        } finally {
            if (mine === seq) searching = false;
        }
    }

    function clear(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        seq++; // invalidate anything in flight
        results = [];
        more = false;
        failed = false;
        searching = false;
        selected = 0;
    }

    return {
        get results() {
            return results;
        },
        get more() {
            return more;
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
         * Schedule a search for `query`, narrowed to `docType` if one is
         * given, or clear when it is empty. Returns a cancel function for the
         * caller's effect: without it the pending timer outlives the
         * component, and a search fired after navigating away writes into
         * state nothing is rendering.
         */
        schedule(query: string, docType: DocumentType | null = null): () => void {
            if (timer) clearTimeout(timer);
            if (!query) {
                clear();
                return () => {};
            }
            searching = true;
            timer = setTimeout(() => void run(query, docType), DEBOUNCE_MS);
            return () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
        },

        /** Forget the results, and anything still on its way. */
        clear,

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
