// What an image node's `align` and `alt` attributes hold, and how to read
// them back.
//
// Pure, like `attachmentRef.ts`, so the schema can be built and tested where
// there is no DOM.

import { attachmentHash } from './attachmentRef';

/** Where an image sits on its line. */
export type ImageAlign = 'left' | 'center' | 'right';

export const IMAGE_ALIGNS: readonly ImageAlign[] = ['left', 'center', 'right'];

/**
 * The `align` to store for `value`: null for left, which is where every image
 * sat before images could be moved, so a note nobody aligns is stored exactly
 * as before. Anything that is not an alignment, from a paste or a document
 * edited by hand, reads as left too.
 */
export function storedAlign(value: unknown): 'center' | 'right' | null {
    return value === 'center' || value === 'right' ? value : null;
}

/** Where an image with the stored `value` sits. */
export function alignOf(value: unknown): ImageAlign {
    return storedAlign(value) ?? 'left';
}

/**
 * An image's description, or '' when it has none.
 *
 * `alt="oyot:<hash>"` is the bookkeeping the editor gives an image it
 * inserts, from before the hash moved into `src`. It is an address, not a
 * description, and a screen reader should not read it out.
 */
export function describedAlt(alt: unknown): string {
    return typeof alt === 'string' && !alt.startsWith('oyot:') ? alt : '';
}

/**
 * The `alt` to store for an image at `src`, holding `alt` now, once its
 * description is set to `description`.
 *
 * A description replaces the bookkeeping. Cleared, an attachment gets its
 * `oyot:<hash>` back, as it had when inserted, so a build that still reads
 * the hash from there finds it; anything else gets no alt at all.
 */
export function altFor(src: unknown, alt: unknown, description: string): string | null {
    const text = description.replace(/\s+/g, ' ').trim();
    if (text) return text;
    const hash = attachmentHash(src, alt);
    return hash ? `oyot:${hash}` : null;
}
