/**
 * What a note is called in an export, given what the user called it.
 *
 * A title is free text and a filename is not, so this is the whole of the
 * translation: one safe name per document, distinct from every other name in
 * the same archive, and stable enough that exporting twice in a row produces
 * the same file names.
 *
 * Rust validates what it is handed regardless (see `commands/export.rs`): the
 * webview is the untrusted surface, so a name from here is a request, not a
 * promise. This module exists so the names are *good*, not so they are safe.
 */

/** Long enough for a real title, short enough for every filesystem. */
const MAX_SLUG_LENGTH = 60;

/**
 * A title reduced to lower-case words joined by hyphens.
 *
 * Non-ASCII letters are kept: a note called "Café" exports as `café.md`, which
 * every filesystem in use today handles, and transliterating it would be a
 * guess about a language we were not told.
 */
export function slugify(title: string): string {
    const slug = title
        .normalize('NFC')
        .toLowerCase()
        // Anything a filesystem, a shell or a URL would argue about.
        .replace(/[\p{C}\p{Zl}\p{Zp}/\\:*?"<>|#%{}$!'`@+=&^~[\]()]/gu, ' ')
        .replace(/[\s.]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/, '');
    return slug;
}

/** Names Windows refuses regardless of extension. */
const RESERVED = new Set([
    'con',
    'prn',
    'aux',
    'nul',
    'com1',
    'com2',
    'com3',
    'com4',
    'com5',
    'com6',
    'com7',
    'com8',
    'com9',
    'lpt1',
    'lpt2',
    'lpt3',
    'lpt4',
    'lpt5',
    'lpt6',
    'lpt7',
    'lpt8',
    'lpt9',
]);

export interface NamedDocument {
    id: string;
    title: string;
}

/**
 * One filename per document, no two the same.
 *
 * Collisions are real and common: journals are titled by date, but two notes
 * called "Ideas" is the normal case, and a title of nothing but punctuation
 * slugs to the empty string. Every one of those falls back to a numeric
 * suffix, in the order the documents were given, so the result depends on the
 * input order and nothing else.
 */
export function assignNoteNames(documents: NamedDocument[]): Map<string, string> {
    const taken = new Set<string>();
    const names = new Map<string, string>();

    for (const doc of documents) {
        const base = slugify(doc.title) || 'untitled';
        const safe = RESERVED.has(base) ? `${base}-note` : base;
        let candidate = `${safe}.md`;
        let n = 2;
        while (taken.has(candidate)) {
            candidate = `${safe}-${n}.md`;
            n++;
        }
        taken.add(candidate);
        names.set(doc.id, candidate);
    }

    return names;
}
