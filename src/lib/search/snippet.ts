// How a search snippet marks the parts of the text that matched.
//
// SQLite's `snippet()` wraps matches in a pair of strings of our choosing.
// Anything printable risks colliding with the note's own text, and the
// previous choice of `[` and `]` did worse than that: the frontend rendered
// the snippet as plain text, so every result showed literal brackets and no
// highlight at all.
//
// These are ASCII control characters (start-of-text and end-of-text). A note
// cannot contain them by any ordinary means, and they carry no meaning in
// HTML, so there is nothing to escape. Kept in step with the `snippet()` call
// in `search_documents`.
export const MATCH_START = '\u0002';
export const MATCH_END = '\u0003';

export interface SnippetPart {
    text: string;
    /** True for the part of the snippet that matched the query. */
    match: boolean;
}

/**
 * Split a snippet into plain and matched runs, for a template to render.
 *
 * Returning parts rather than HTML is what keeps a note's own text from ever
 * being interpreted as markup: the caller renders each part as text, and the
 * highlight is an element it creates itself.
 */
export function snippetParts(snippet: string): SnippetPart[] {
    const parts: SnippetPart[] = [];
    let rest = snippet;

    while (rest.length > 0) {
        const start = rest.indexOf(MATCH_START);
        if (start === -1) break;

        const end = rest.indexOf(MATCH_END, start + 1);
        // An unpaired marker means the snippet was truncated mid-match, or is
        // not the shape we expect. Keep the remaining text rather than losing
        // it; a missing highlight is better than a missing result.
        if (end === -1) break;

        if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
        const matched = rest.slice(start + 1, end);
        if (matched) parts.push({ text: matched, match: true });
        rest = rest.slice(end + 1);
    }

    if (rest.length > 0) parts.push({ text: rest, match: false });
    return parts;
}
