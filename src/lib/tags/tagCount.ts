import { invoke } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';

/**
 * How many distinct tags the corpus holds, for the sidebar badge.
 *
 * A store rather than a derived value, because unlike the todo badge there is
 * nothing already in memory to derive it from. The document store carries each
 * document's todo counts, so that badge is free; a tag belongs to no single
 * document, and putting every document's tags in the list payload would cost
 * far more than asking for one integer.
 *
 * It is one integer, and not a count of `loadAllTags`, because this is the one
 * caller that runs on every save: the sidebar is mounted on every route.
 */
export const tagCount = writable(0);

let seq = 0;

/**
 * Ask again. Safe to call as often as the derived rows change.
 *
 * A failure leaves the last known count rather than showing zero: a badge that
 * says there are no tags is a claim, and a query that did not answer is not
 * grounds for making it.
 */
export async function refreshTagCount(): Promise<void> {
    const mine = ++seq;
    try {
        const count = await invoke<number>('get_tag_count');
        // Drop a response a newer request has already superseded. Saves arrive
        // in bursts, and each one asks again.
        if (mine !== seq) return;
        tagCount.set(count);
    } catch (error) {
        console.error('[tags] could not count the tags:', error);
    }
}
