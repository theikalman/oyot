// Where a search looks: the choices the Search page offers, and what each
// one finds.
//
// Pure, and separate from the page, for the reason the note and journal
// indexes are: what a choice means is a rule, and the page is only markup
// over it.

/** What a search can be narrowed to. */
export type SearchScope = 'all' | 'notes' | 'journals' | 'todos' | 'tags';

/** The choices answered by the full-text index of titles and text. */
export type TextScope = Extract<SearchScope, 'all' | 'notes' | 'journals'>;

/** A kind of document, as the full-text search is narrowed to one. */
export type DocumentType = 'note' | 'journal';

export interface ScopeInfo {
    id: SearchScope;
    /** The choice, as the page offers it. */
    label: string;
    /** What the search box says while it is empty. */
    placeholder: string;
    /** What the page says before anything is typed: what this search finds. */
    hint: string;
    /** What one result is, for "No note matches". */
    noun: string;
}

/**
 * Every choice, in the order the page offers them. Everything first, since
 * it is where a search starts, and then the sidebar's Index order.
 */
export const SCOPES: readonly ScopeInfo[] = [
    {
        id: 'all',
        label: 'All',
        placeholder: 'Search notes and journals',
        hint: 'Type a word or two to find the notes and journals that have them, in the title or anywhere in the text.',
        noun: 'note or journal',
    },
    {
        id: 'notes',
        label: 'Notes',
        placeholder: 'Search notes',
        hint: 'Type a word or two to find the notes that have them, in the title or anywhere in the text.',
        noun: 'note',
    },
    {
        id: 'journals',
        label: 'Journals',
        placeholder: 'Search journals',
        hint: "Type a word or two to find the journals that have them. A date such as 2026-09 finds that month's days.",
        noun: 'journal',
    },
    {
        id: 'todos',
        label: 'Todos',
        placeholder: 'Search todos',
        hint: 'Type a word or two to find the tasks that have them, in every note and journal, done or not.',
        noun: 'todo',
    },
    {
        id: 'tags',
        label: 'Tags',
        placeholder: 'Search tags',
        hint: 'Type a tag, or part of one, to find the notes and journals that carry it.',
        noun: 'tag',
    },
];

/** What the page says about `scope`. */
export function scopeInfo(scope: SearchScope): ScopeInfo {
    return SCOPES.find((info) => info.id === scope) ?? SCOPES[0];
}

/**
 * Whether `value` is one of the choices. A search kept in the history is
 * read back from session storage, which may hold one an older build wrote.
 */
export function isScope(value: unknown): value is SearchScope {
    return SCOPES.some((info) => info.id === value);
}

/** Whether `scope` is answered by the full-text index rather than a filter. */
export function isTextScope(scope: SearchScope): scope is TextScope {
    return scope === 'all' || scope === 'notes' || scope === 'journals';
}

/** The kind of document a text search is narrowed to, or null for both. */
export function documentTypeFor(scope: TextScope): DocumentType | null {
    if (scope === 'notes') return 'note';
    if (scope === 'journals') return 'journal';
    return null;
}
