import { invoke } from '@tauri-apps/api/core';
import type { SearchHit } from './results';
import type { DocumentType } from './scopes';

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
 * The state behind the Search page's full-text search.
 *
 * Its own module because it is a small state machine with things that have
 * to stay in step: a debounce, and a sequence number so a slow response
 * cannot overwrite a newer one. Mixed into a component with other concerns,
 * each of those was a separate `let` that any of the others could get wrong.
 * Which row the arrow keys are on is the page's, since it moves through the
 * todo and tag rows as well, which are not this search's.
 */
export function createSearch() {
    let results = $state<SearchHit[]>([]);
    // Whether the index found more than `results` holds.
    let more = $state(false);
    let searching = $state(false);
    // A failed search must not render as "nothing matches": that reads as an
    // answer when it is the absence of one.
    let failed = $state(false);

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
    };
}

export type Search = ReturnType<typeof createSearch>;
