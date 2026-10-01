import type { TextRange } from './todoSearch';

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

/** A piece of a segment, marked when it is part of what a search found. */
export interface MarkedRun {
    text: string;
    match: boolean;
}

/**
 * A segment cut into runs where a search's finds begin and end. A chip's
 * runs spell it the way the text does, `#name`, so a find is marked inside
 * a chip as well as around one.
 */
export type MarkedSegment =
    { kind: 'text'; runs: MarkedRun[] } | { kind: 'tag'; name: string; runs: MarkedRun[] };

/**
 * Mark what a search found in a todo, segment by segment.
 *
 * `found` is in order and does not overlap, as `findTerms` gives it, and its
 * offsets are into the text the segments were cut from, which they spell out
 * character for character. Nothing is marked for no finds.
 */
export function markSegments(
    segments: TodoSegment[],
    found: readonly TextRange[],
): MarkedSegment[] {
    let offset = 0;
    return segments.map((segment) => {
        const spelled = segment.kind === 'tag' ? `#${segment.name}` : segment.text;
        const runs = markRuns(spelled, offset, found);
        offset += spelled.length;
        return segment.kind === 'tag'
            ? { kind: 'tag', name: segment.name, runs }
            : { kind: 'text', runs };
    });
}

/**
 * `text` cut into runs where the finds in it begin and end, for text that
 * is drawn whole, such as a tag's name on its chip.
 */
export function markText(text: string, found: readonly TextRange[]): MarkedRun[] {
    return markRuns(text, 0, found);
}

/** `text`, found at `offset` in its todo, cut where the finds begin and end. */
function markRuns(text: string, offset: number, found: readonly TextRange[]): MarkedRun[] {
    const runs: MarkedRun[] = [];
    let from = 0;
    for (const range of found) {
        const start = Math.max(range.start - offset, from);
        const end = Math.min(range.end - offset, text.length);
        if (start >= end) continue;
        if (start > from) runs.push({ text: text.slice(from, start), match: false });
        runs.push({ text: text.slice(start, end), match: true });
        from = end;
    }
    if (from < text.length) runs.push({ text: text.slice(from), match: false });
    return runs;
}
