/** One run of a todo's text, as the todo index draws it: words, or a tag. */
export type TodoSegment = { kind: 'text'; text: string } | { kind: 'tag'; name: string };

/**
 * A character that carries on the word before it. One straight after `#name`
 * means the hash began a longer word that was typed out, not a chip.
 */
const CONTINUES_WORD = /[\p{L}\p{N}_-]/u;

/**
 * Find the tag chips in a todo's text again.
 *
 * The indexer stores a task item as one line of plain text, with each chip
 * spelled `#name` (`inlineText` in src/lib/editor/documentIndex.ts), so the
 * row no longer says which of its hashes were chips. The document's own tags
 * do: every chip in the item is one of them, and a hash that spells none of
 * them was typed, so it stays words.
 *
 * This reads the text rather than a record of where the chips were, and it
 * can be wrong one way: a hash typed by hand that spells a tag the same
 * document carries is drawn as a chip. The words are the same either way.
 * Recording where each chip falls would be exact, at the cost of a new column
 * and a re-render of the whole corpus to fill it, which is a lot to spend on
 * how a row looks.
 *
 * Longest name first, so `#project x` is the tag `project x`, and not
 * `project` and a stray x, when the document carries both. A name with more
 * of a word straight after it is not taken, so a typed `#workshop` does not
 * turn into a `work` chip followed by "shop". A chip has the space its
 * insertion adds after it, or punctuation, or the end of the line, and one
 * with a word butted against it is shown as plain text.
 */
export function todoSegments(text: string, tags: readonly string[]): TodoSegment[] {
    const names = [...new Set(tags)]
        .filter((name) => name.length > 0)
        .sort((a, b) => b.length - a.length);

    const segments: TodoSegment[] = [];
    let plainFrom = 0;

    for (let hash = text.indexOf('#'); hash !== -1;) {
        const start = hash + 1;
        const name = names.find(
            (candidate) =>
                text.startsWith(candidate, start) && !continuesWord(text, start + candidate.length),
        );
        if (!name) {
            hash = text.indexOf('#', start);
            continue;
        }

        if (hash > plainFrom) segments.push({ kind: 'text', text: text.slice(plainFrom, hash) });
        segments.push({ kind: 'tag', name });
        plainFrom = start + name.length;
        hash = text.indexOf('#', plainFrom);
    }

    if (plainFrom < text.length) segments.push({ kind: 'text', text: text.slice(plainFrom) });
    return segments;
}

/** Whether the character at `index` carries on a word. False past the end. */
function continuesWord(text: string, index: number): boolean {
    const code = text.codePointAt(index);
    return code !== undefined && CONTINUES_WORD.test(String.fromCodePoint(code));
}
