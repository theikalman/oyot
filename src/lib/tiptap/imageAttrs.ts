// What an image node's `align` attribute holds, and how to read it back.
//
// Pure, like `attachmentRef.ts`, so the schema can be built and tested where
// there is no DOM.

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
