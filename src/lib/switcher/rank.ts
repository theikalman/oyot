// How the quick switcher orders what it finds for the words typed: a title
// that starts with them first, then one with a word that does, then one that
// has them anywhere. Every word typed has to be found for a thing to match.

/** How well `text` answers `query`: 0 when it does not, higher is better. */
export function matchScore(text: string, query: string): number {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return 0;
    const hay = text.toLowerCase();
    let score = 0;
    for (const word of words) {
        const at = hay.indexOf(word);
        if (at === -1) return 0;
        if (at === 0) score += 3;
        else if (/[\s\-_/#(]/.test(hay[at - 1])) score += 2;
        else score += 1;
    }
    // Shorter titles win a tie: "Nixiza" before "Nixiza - Development".
    return score + 1 / (1 + hay.length);
}

/**
 * The items that match, best first, at most `limit` of them. Items that
 * score the same keep the order they came in.
 */
export function rank<T>(
    items: T[],
    query: string,
    textOf: (item: T) => string,
    limit: number,
): T[] {
    return items
        .map((item, i) => ({ item, i, score: matchScore(textOf(item), query) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, limit)
        .map((s) => s.item);
}

/** The parts of `text` that the query's words matched, for marking them. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const marked = new Array<boolean>(text.length).fill(false);
    const hay = text.toLowerCase();
    for (const word of words) {
        const at = hay.indexOf(word);
        if (at !== -1) for (let i = at; i < at + word.length; i++) marked[i] = true;
    }
    const runs: { text: string; match: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
        const last = runs.at(-1);
        if (last && last.match === marked[i]) last.text += text[i];
        else runs.push({ text: text[i], match: marked[i] });
    }
    return runs;
}
