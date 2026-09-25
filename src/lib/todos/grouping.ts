import { NO_TAGS, tagsOf, type TagsByDocument } from '$lib/tags/documentTags';

/** One task item, as `get_all_todos` returns it. */
export interface TodoHit {
    document_id: string;
    document_title: string;
    doc_type: string;
    /** Which task item this is within its document, counted depth-first. */
    ordinal: number;
    text: string;
    checked: boolean;
    depth: number;
}

/** One document's todos, under the heading they are shown beneath. */
export interface TodoGroup {
    docId: string;
    title: string;
    docType: string;
    /**
     * The tags the document carries, which are what tell a chip in one of its
     * todos from a hash typed by hand (see `todoSegments`).
     */
    tags: string[];
    todos: TodoHit[];
}

/**
 * Journals and notes are kept apart because they are read differently: a
 * journal by the day it belongs to, a note by what it is called.
 */
export interface TodoSections {
    journals: TodoGroup[];
    notes: TodoGroup[];
}

export const EMPTY_SECTIONS: TodoSections = { journals: [], notes: [] };

/**
 * Split the rows into sections of per-document groups.
 *
 * The order is the query's: journals newest day first, notes by recency, and
 * within a document the order the items appear on the page. Nothing is sorted
 * here, because the two sections want different keys and only SQL has both.
 * Rows for one document are contiguous, which the query guarantees by making
 * its ordering total.
 */
export function groupTodos(hits: TodoHit[], tags: TagsByDocument = NO_TAGS): TodoSections {
    const sections: TodoSections = { journals: [], notes: [] };

    let current: TodoGroup | null = null;
    for (const hit of hits) {
        if (!current || current.docId !== hit.document_id) {
            current = {
                docId: hit.document_id,
                title: hit.document_title,
                docType: hit.doc_type,
                tags: tagsOf(tags, hit.document_id),
                todos: [],
            };
            (hit.doc_type === 'journal' ? sections.journals : sections.notes).push(current);
        }
        current.todos.push(hit);
    }

    return sections;
}

/** How many of these are still outstanding. */
export function countOpen(sections: TodoSections): number {
    return [...sections.journals, ...sections.notes].reduce(
        (n, group) => n + group.todos.filter((todo) => !todo.checked).length,
        0,
    );
}

export function countAll(sections: TodoSections): number {
    return [...sections.journals, ...sections.notes].reduce(
        (n, group) => n + group.todos.length,
        0,
    );
}
