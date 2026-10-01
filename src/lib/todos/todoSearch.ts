import type { TodoGroup, TodoSections } from './grouping';

// Finding a todo by what it says.
//
// The Todos page already has every todo in hand, so its search is a filter
// over those rows, as the Notes and Tags pages filter theirs, and not a
// query: the full-text index behind the Search page's text search holds
// documents, not task items (ADR 0017). The Search page finds todos, and
// tags by their names, with these same rules, so a word finds the same
// todos on either page.
//
// It reads a query the way the full-text search does: every word has to be
// in the todo, in any order, and neither case nor accents matter, so "cafe"
// finds "Café". Unlike there, a word is found inside a longer one as well as
// at its start, as the Notes and Tags filters find theirs. That also finds
// words in writing that puts no spaces between them, and the page marks
// every find, so a todo found by the middle of a word shows why.

/** Where a search found a word in a todo's text: `text.slice(start, end)`. */
export interface TextRange {
    start: number;
    end: number;
}

/** The marks an accented letter leaves behind it once decomposed (NFD). */
const ACCENTS = /[\u0300-\u036f]/g;

/**
 * `text` in lower case and without accents, folded a character at a time.
 *
 * Given `origin`, fills it with where in `text` the character behind each
 * folded code unit starts, and then with the length of `text`, so a find in
 * the folded text can be traced back to the characters it covers. A
 * character does not always fold to one code unit: a mark on its own folds
 * to none, and a Hangul syllable to two or three.
 */
function fold(text: string, origin?: number[]): string {
    let folded = '';
    let at = 0;
    for (const char of text) {
        // Most of what anyone types is ASCII, which has no accents to take
        // off, and normalizing is the slow part.
        const plain =
            char.charCodeAt(0) < 0x80
                ? char.toLowerCase()
                : char.toLowerCase().normalize('NFD').replace(ACCENTS, '');
        folded += plain;
        if (origin) for (let i = 0; i < plain.length; i++) origin.push(at);
        at += char.length;
    }
    origin?.push(at);
    return folded;
}

/**
 * The words of a query, folded as a todo's text is. None for a blank query,
 * which every todo matches.
 */
export function searchTerms(query: string): string[] {
    const terms = query
        .split(/\s+/)
        .map((word) => fold(word))
        .filter((term) => term.length > 0);
    return [...new Set(terms)];
}

/** Whether `text` has every one of `terms` in it. */
export function hasTerms(text: string, terms: readonly string[]): boolean {
    if (terms.length === 0) return true;
    const folded = fold(text);
    return terms.every((term) => folded.includes(term));
}

/**
 * Everywhere each of `terms` is in `text`, in order, with finds that overlap
 * or touch joined into one. Null when any term is missing, because a todo is
 * only found by all of them.
 */
export function findTerms(text: string, terms: readonly string[]): TextRange[] | null {
    if (terms.length === 0) return [];
    return scan(text, terms, true);
}

/**
 * Everywhere any of `terms` is in `text`, joined as `findTerms` joins them,
 * and nothing when none of them is. For a search that takes its words from
 * more than one piece of text, such as a document's tags, where one tag can
 * hold some of the words and the next the rest.
 */
export function findAnyTerms(text: string, terms: readonly string[]): TextRange[] {
    return scan(text, terms, false) ?? [];
}

/**
 * The finds of each of `terms` in `text`, joined. Null when `every` asks for
 * all of them and one is missing.
 */
function scan(text: string, terms: readonly string[], every: boolean): TextRange[] | null {
    const origin: number[] = [];
    const folded = fold(text, origin);

    const found: TextRange[] = [];
    for (const term of terms) {
        // An empty term is found everywhere, and searching on past the end
        // of the text for it would never stop.
        if (!term) continue;
        let at = folded.indexOf(term);
        if (at === -1) {
            if (every) return null;
            continue;
        }
        for (; at !== -1; at = folded.indexOf(term, at + 1)) {
            found.push(inOriginal(origin, at, at + term.length));
        }
    }
    return joined(found);
}

/**
 * The part of the original text a find in its folded form covers: the whole
 * of every character the find touches, and then any that folded to nothing
 * straight after it, such as an accent typed as a mark of its own, which
 * belongs to the letter before it.
 */
function inOriginal(origin: readonly number[], start: number, end: number): TextRange {
    const last = origin.length - 1;
    let next = end;
    while (next < last && origin[next] === origin[end - 1]) next++;
    return { start: origin[start], end: origin[next] };
}

/** The ranges in order, with any that overlap or touch made one. */
function joined(ranges: TextRange[]): TextRange[] {
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const out: TextRange[] = [];
    for (const range of ranges) {
        const previous = out[out.length - 1];
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            out.push({ ...range });
        }
    }
    return out;
}

/**
 * The todos with every one of `terms` in them, grouped as they were, without
 * the groups left with none. Every todo, as it came, for no terms.
 */
export function searchSections(sections: TodoSections, terms: readonly string[]): TodoSections {
    if (terms.length === 0) return sections;
    return {
        journals: searchGroups(sections.journals, terms),
        notes: searchGroups(sections.notes, terms),
    };
}

function searchGroups(groups: TodoGroup[], terms: readonly string[]): TodoGroup[] {
    const found: TodoGroup[] = [];
    for (const group of groups) {
        const todos = group.todos.filter((todo) => hasTerms(todo.text, terms));
        if (todos.length > 0) found.push({ ...group, todos });
    }
    return found;
}
