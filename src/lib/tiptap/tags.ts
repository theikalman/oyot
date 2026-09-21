/**
 * What a tag is, before any of the machinery that stores or renders one.
 *
 * Kept free of the editor, the popup and IPC so the rules a tag has to obey
 * can be tested as the pure functions they are. Three things read them and all
 * three have to agree: the indexer writing rows, the picker listing them, and
 * the insert that puts a chip in the document.
 */

/** The schema's name for the chip, here so code that never touches the
 * editor can still recognise one. */
export const TAG_NODE_NAME = 'tag';

/** Long enough for a phrase, short enough that a chip stays a chip. */
export const MAX_TAG_LENGTH = 50;

/**
 * The one form of a tag name that is ever stored, matched or displayed.
 *
 * Tags are case-insensitive, and the way that is enforced is by there being a
 * single form: `#Work` and `#work` are the same tag and it is spelled `work`.
 * The alternative, keeping the case the user typed and comparing without it,
 * needs a display form and a match form to be carried around together, and
 * then a rule for which of two spellings wins when both are in the corpus.
 * There is no answer to that which is not arbitrary, so there is one spelling.
 *
 * A leading `#` is dropped because the chip renders one; a user who types it
 * anyway means the tag, not a tag whose name starts with a hash.
 */
export function normalizeTagName(raw: string): string {
    return raw
        .replace(/^[\s#]+/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .slice(0, MAX_TAG_LENGTH)
        .trim();
}

/** One tag and how much of the corpus carries it. */
export interface TagSummary {
    /** Normalized, as `normalizeTagName` returns it. */
    name: string;
    /**
     * Live documents holding this tag, as SQL last answered. Zero for a tag
     * that is only in the open document, which has not been saved yet and so
     * is in no row anywhere.
     */
    documentCount: number;
}

/** A row in the tag picker. */
export interface TagPickerItem {
    /**
     * Distinct per row, because the popup hands back an id and nothing else.
     * Prefixed rather than bare, so the row that creates `work` cannot collide
     * with the row that picks the existing `work`.
     */
    id: string;
    /** The tag this row would insert, normalized. */
    name: string;
    /** What the row reads as. */
    title: string;
    subtitle?: string;
    /** True for the row that coins a tag the corpus does not have yet. */
    isNew: boolean;
}

function usageLabel(count: number): string {
    if (count <= 0) return 'in this note';
    return count === 1 ? '1 note' : `${count} notes`;
}

/**
 * The rows to show for what the user has typed so far.
 *
 * `known` is expected in the order it should be offered in; this filters it
 * and does not re-rank, so the caller's idea of which tags matter most (how
 * much of the corpus uses them) survives being narrowed.
 *
 * The create row is last and only appears when there is a name to create and
 * no existing tag already spells it. Offering it above the matches would put
 * "add a new tag" under the cursor while the tag the user was reaching for sat
 * one line below, and Enter would coin a duplicate.
 */
export function tagPickerItems(known: TagSummary[], query: string): TagPickerItem[] {
    const wanted = normalizeTagName(query);

    const matches = known
        .filter((tag) => tag.name.includes(wanted))
        .map((tag) => ({
            id: `tag:${tag.name}`,
            name: tag.name,
            title: `#${tag.name}`,
            subtitle: usageLabel(tag.documentCount),
            isNew: false,
        }));

    if (!wanted || known.some((tag) => tag.name === wanted)) return matches;

    return [
        ...matches,
        {
            id: `new:${wanted}`,
            name: wanted,
            title: `Add #${wanted} as a new tag`,
            isNew: true,
        },
    ];
}

/**
 * Fold the tags found in a document into a list of known ones.
 *
 * The list the picker offers comes from SQL, which only learns about a tag when
 * the document holding it is saved. Without this, a tag coined a moment ago in
 * the note still being typed in is missing from the picker in that same note,
 * which reads as the feature having forgotten it.
 */
export function mergeTagNames(known: TagSummary[], names: string[]): TagSummary[] {
    const seen = new Set(known.map((tag) => tag.name));
    const extra = names
        .filter((name) => name && !seen.has(name))
        .map((name) => ({ name, documentCount: 0 }));
    return [...known, ...extra];
}
