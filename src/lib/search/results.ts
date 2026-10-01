// The rows of the Search page, whatever was searched.
//
// Each choice of what to search answers in its own shape: the full-text index
// in hits, the todo index in task items grouped by document, the tags in a
// map of documents to names. The page lists them all the same way, a row that
// opens what it names, with the arrow keys moving through them, so each is
// turned into rows here, where the rules can be tested without a page.

import { tagsOf, type TagsByDocument } from '$lib/tags/documentTags';
import type { TodoSections } from '$lib/todos/grouping';
import {
    findAnyTerms,
    findTerms,
    hasTerms,
    searchSections,
    searchTerms,
} from '$lib/todos/todoSearch';
import {
    markSegments,
    markText,
    todoSegments,
    type MarkedRun,
    type MarkedSegment,
} from '$lib/todos/todoText';
import type { DocumentSummary } from '$lib/types';
import { snippetParts, type SnippetPart } from './snippet';

/** One hit from the full-text index, as `search_documents` returns it. */
export interface SearchHit {
    id: string;
    doc_type: string;
    title: string;
    /** The title with the words that matched between the snippet's markers. */
    marked_title: string;
    /** Some of the text around what matched, marked the same way. */
    snippet: string;
}

interface ResultBase {
    /**
     * Unique among one search's rows, and the same for the same thing from
     * one search to the next, so the row the keyboard is on can be found
     * again once the rows are read afresh.
     */
    key: string;
    /** The document the row opens. */
    docId: string;
    docType: string;
    /** That document's title as stored; a journal's is its date. */
    title: string;
}

/** A note or a journal, found by its title or its text. */
export interface DocumentResult extends ResultBase {
    kind: 'document';
    /** The title, with the words that matched marked. */
    titleParts: SnippetPart[];
    /** Some of the text around what matched, marked the same way. */
    snippet: SnippetPart[];
}

/** A task item, found by its words. */
export interface TodoResult extends ResultBase {
    kind: 'todo';
    /** Which of its document's task items it is, which is how it is opened. */
    ordinal: number;
    checked: boolean;
    /** Its words and chips, with what the search found marked. */
    text: MarkedSegment[];
}

/** A note or a journal, found by its tags. */
export interface TaggedResult extends ResultBase {
    kind: 'tagged';
    /** The tags the search found, each spelled `#name`, with what matched marked. */
    tags: { name: string; runs: MarkedRun[] }[];
}

export type SearchResult = DocumentResult | TodoResult | TaggedResult;

/** The rows for what the full-text index found, in the order it ranked them. */
export function documentResults(hits: readonly SearchHit[]): DocumentResult[] {
    return hits.map((hit) => ({
        kind: 'document',
        key: hit.id,
        docId: hit.id,
        docType: hit.doc_type,
        title: hit.title,
        titleParts: snippetParts(hit.marked_title || hit.title),
        snippet: snippetParts(hit.snippet),
    }));
}

/**
 * The task items with every one of `terms` in them, finished or not, in the
 * Todos page's order: journals newest day first, then notes. None for no
 * terms: an empty search box is a question not yet asked, not one every
 * todo answers.
 */
export function todoResults(sections: TodoSections, terms: readonly string[]): TodoResult[] {
    if (terms.length === 0) return [];
    const found = searchSections(sections, terms);
    return [...found.journals, ...found.notes].flatMap((group) =>
        group.todos.map((todo): TodoResult => ({
            kind: 'todo',
            key: `${group.docId}/${todo.ordinal}`,
            docId: group.docId,
            docType: group.docType,
            title: group.title,
            ordinal: todo.ordinal,
            checked: todo.checked,
            text: markSegments(
                todoSegments(todo.text, group.tags),
                findTerms(todo.text, terms) ?? [],
            ),
        })),
    );
}

/**
 * The words to look for in tag names. A tag is spelled with a hash, so a word
 * typed with one means the same word: `#work` looks for "work". A hash alone
 * is nothing to look for yet.
 */
export function tagTerms(query: string): string[] {
    const terms = searchTerms(query)
        .map((term) => term.replace(/^#+/, ''))
        .filter((term) => term.length > 0);
    return [...new Set(terms)];
}

/**
 * The documents with every one of `terms` in one or another of their tags,
 * each with the tags that hold them.
 *
 * Every word has to be in some tag, as every word has to be in a todo, but
 * not all in the same one: `work urgent` finds what is tagged both #work and
 * #urgent, which is the question two words about tags usually ask. A tag
 * holding none of the words is left off the row, so it shows why the
 * document was found.
 *
 * In the order a tag's own page lists its documents: journals newest day
 * first, then notes by when they last changed.
 */
export function taggedResults(
    documents: readonly DocumentSummary[],
    tags: TagsByDocument,
    terms: readonly string[],
): TaggedResult[] {
    if (terms.length === 0) return [];

    const results: TaggedResult[] = [];
    for (const doc of [...documents].sort(tagPageOrder)) {
        const names = tagsOf(tags, doc.id);
        if (!terms.every((term) => names.some((name) => hasTerms(name, [term])))) continue;

        const found = names.flatMap((name) => {
            const chip = `#${name}`;
            const finds = findAnyTerms(chip, terms);
            return finds.length > 0 ? [{ name, runs: markText(chip, finds) }] : [];
        });
        results.push({
            kind: 'tagged',
            key: doc.id,
            docId: doc.id,
            docType: doc.doc_type,
            title: doc.title,
            tags: found,
        });
    }
    return results;
}

/**
 * Journals before notes, journals newest day first, notes most recently
 * changed first, and the id to settle a tie, as `get_documents_by_tag`
 * orders them.
 */
function tagPageOrder(a: DocumentSummary, b: DocumentSummary): number {
    if (a.doc_type !== b.doc_type) return a.doc_type === 'journal' ? -1 : 1;
    const order =
        a.doc_type === 'journal' ? b.title.localeCompare(a.title) : b.updated_at - a.updated_at;
    return order || a.id.localeCompare(b.id);
}
