/**
 * The emoji the editor can insert, and how a query finds them.
 *
 * An emoji goes into a note as the character itself, not as a node. Text is
 * what every other reader of a note already understands: the Markdown export,
 * the search index, the MCP tools, a peer on an older version of the app.
 * A node would have needed teaching to each of them, and an old peer would
 * have dropped it.
 *
 * The data is Emojibase's, with GitHub's shortcodes, the ones most people
 * already know from typing `:+1:` into a comment. It is loaded the first time
 * it is wanted rather than with the editor: it is half a megabyte, and most
 * notes are written without an emoji in them.
 */

export interface Emoji {
    /** The character, as inserted. */
    emoji: string;
    /** Unique across the set, for keying rows. */
    hexcode: string;
    /** What Unicode calls it, in lower case: "thumbs up". */
    name: string;
    /** Without the colons: "+1", "thumbsup". */
    shortcodes: string[];
    /** Further words it answers to: "like", "yes". */
    tags: string[];
}

// The shape of the Emojibase records read here, declared rather than imported
// because its types live in a separate package this one has no other use for.
interface CompactRecord {
    hexcode: string;
    label: string;
    unicode: string;
    group?: number;
    tags?: string[];
}

type ShortcodeRecords = Record<string, string | string[]>;

/** Emojibase's group for skin tones and hair styles, which are parts of an
 * emoji rather than emoji of their own. */
const COMPONENT_GROUP = 2;

/** The rows a search returns, at most. */
export const MAX_RESULTS = 30;

/** Built from the two datasets. Kept apart from the loading so it can be tested
 * without the data. */
export function buildEmojiList(records: CompactRecord[], shortcodes: ShortcodeRecords): Emoji[] {
    const list: Emoji[] = [];
    for (const record of records) {
        // No group is a regional indicator letter, which only means something
        // as half of a flag.
        if (record.group === undefined || record.group === COMPONENT_GROUP) continue;
        const codes = shortcodes[record.hexcode];
        list.push({
            emoji: record.unicode,
            hexcode: record.hexcode,
            name: record.label.toLowerCase(),
            shortcodes: codes === undefined ? [] : Array.isArray(codes) ? codes : [codes],
            tags: record.tags ?? [],
        });
    }
    return list;
}

let loaded: Emoji[] | null = null;
let loading: Promise<Emoji[]> | null = null;
let byShortcode: Map<string, Emoji> | null = null;

/** Every emoji, in Unicode's order, which puts the faces first. */
export function loadEmoji(): Promise<Emoji[]> {
    if (loaded) return Promise.resolve(loaded);
    loading ??= Promise.all([
        import('emojibase-data/en/compact.json'),
        import('emojibase-data/en/shortcodes/github.json'),
    ])
        .then(([records, shortcodes]) => {
            loaded = buildEmojiList(
                records.default as unknown as CompactRecord[],
                shortcodes.default as unknown as ShortcodeRecords,
            );
            return loaded;
        })
        .catch((err) => {
            // Let the next attempt try again rather than keep the failure.
            loading = null;
            throw err;
        });
    return loading;
}

/** The list, if it has been loaded; for the callers that cannot wait. */
export function loadedEmoji(): Emoji[] | null {
    return loaded;
}

/**
 * The emoji a whole shortcode names, if the data is loaded. For `:smile:`
 * typed out in full, which is converted as the closing colon goes in and so
 * cannot wait for a load.
 */
export function emojiForShortcode(code: string): Emoji | undefined {
    if (!loaded) return undefined;
    if (!byShortcode) {
        byShortcode = new Map();
        for (const emoji of loaded) {
            for (const shortcode of emoji.shortcodes) byShortcode.set(shortcode, emoji);
        }
    }
    return byShortcode.get(code.toLowerCase());
}

/**
 * The emoji that match what was typed, best first.
 *
 * A shortcode is what someone typing after a colon is most likely spelling,
 * so it ranks above the name, and the name above the looser tags. Within a
 * rank, Unicode's order stands, so the common faces come before the rarer
 * ones that happen to match as well. An empty query is the start of the list.
 */
export function searchEmoji(list: Emoji[], query: string, limit = MAX_RESULTS): Emoji[] {
    const q = query
        .trim()
        .toLowerCase()
        .replace(/^:+|:+$/g, '');
    if (q === '') return list.slice(0, limit);

    const ranked: { emoji: Emoji; rank: number; index: number }[] = [];
    list.forEach((emoji, index) => {
        const rank = rankOf(emoji, q);
        if (rank !== null) ranked.push({ emoji, rank, index });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return ranked.slice(0, limit).map((entry) => entry.emoji);
}

function rankOf(emoji: Emoji, q: string): number | null {
    if (emoji.shortcodes.includes(q)) return 0;
    if (emoji.shortcodes.some((code) => code.startsWith(q))) return 1;
    if (emoji.name === q) return 2;
    if (words(emoji.name).some((word) => word.startsWith(q))) return 3;
    if (emoji.tags.some((tag) => tag.startsWith(q))) return 4;
    if (emoji.shortcodes.some((code) => code.includes(q)) || emoji.name.includes(q)) return 5;
    return null;
}

function words(name: string): string[] {
    return name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
