// Each tag keeps one colour, picked from its name, so #work is the same blue
// in the editor, the lists and the Tags page, and on every device, with
// nothing stored. The colours are --tag-1 to --tag-8 in each scheme.

export const TAG_HUES = 8;

/** Which of the scheme's tag hues a tag gets, from 1 to TAG_HUES. */
export function tagHue(name: string): number {
    // FNV-1a over the lower-cased name: cheap, and spreads short names well.
    let hash = 0x811c9dc5;
    for (const ch of name.toLowerCase()) {
        hash ^= ch.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193);
    }
    return ((hash >>> 0) % TAG_HUES) + 1;
}

/** The CSS a tag is drawn with: its hue, for the .tag-pill's #. */
export function tagHueStyle(name: string): string {
    return `--tag-hue: var(--tag-${tagHue(name)})`;
}
