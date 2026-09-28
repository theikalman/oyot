/**
 * The block of YAML a Markdown file can open with, read for its values.
 *
 * Front matter is where the exporter writes a note's title and tags, and where
 * Obsidian, Jekyll, Hugo and most other tools keep theirs. This is not a YAML
 * parser. It reads the part of YAML front matter is written in: `key: value`
 * at the top level, quoted or plain, lists written `[a, b]` or as `- a` lines
 * under their key, and folded or literal blocks. A value in any other shape,
 * a nested map for one, reads as null rather than as something it is not,
 * and only the values a note has a place for are ever asked for.
 */

/** A top-level value: text, a list of text, or null for anything else. */
export type FrontMatterValue = string | string[] | null;

export interface SplitFile {
    /** The front matter's values by key, as written. Empty without any. */
    values: Map<string, FrontMatterValue>;
    /** The rest of the file. */
    body: string;
}

const DELIMITER = /^---[ \t]*$/;
const CLOSER = /^(---|\.\.\.)[ \t]*$/;
/** `key: value` or `key:` at the top level. */
const KEY_LINE = /^([^\s#'"\-:[{][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*?))?[ \t]*$/;
const COMMENT_OR_BLANK = /^[ \t]*(#.*)?$/;

/**
 * Split a file into its front matter and the rest.
 *
 * The block has to open the file and be closed, and its first line with
 * anything on it has to be a key. A file that merely starts with a rule, and
 * has another further down, is Markdown: taking it for front matter would
 * drop the words between the two.
 */
export function splitFrontMatter(text: string): SplitFile {
    const none: SplitFile = { values: new Map(), body: text };
    const lines = text.split('\n');
    if (!DELIMITER.test(lines[0] ?? '')) return none;

    const close = lines.findIndex((line, index) => index > 0 && CLOSER.test(line));
    if (close < 0) return none;

    const block = lines.slice(1, close);
    const first = block.find((line) => !COMMENT_OR_BLANK.test(line));
    if (first !== undefined && !KEY_LINE.test(first)) return none;

    return { values: readValues(block), body: lines.slice(close + 1).join('\n') };
}

function readValues(lines: string[]): Map<string, FrontMatterValue> {
    const values = new Map<string, FrontMatterValue>();
    let i = 0;
    while (i < lines.length) {
        const match = KEY_LINE.exec(lines[i]);
        i++;
        if (!match) continue;
        const [, key, inline = ''] = match;

        // What belongs to this key: the lines after it that are indented or
        // are list items, up to the next thing at the top level.
        const start = i;
        while (i < lines.length && (/^[ \t]/.test(lines[i]) || LIST_ITEM.test(lines[i]))) i++;
        const nested = lines.slice(start, i).filter((line) => !COMMENT_OR_BLANK.test(line));

        values.set(key, valueOf(inline, nested));
    }
    return values;
}

function valueOf(inline: string, nested: string[]): FrontMatterValue {
    if (inline && !inline.startsWith('#')) {
        if (/^[|>]/.test(inline)) return block(inline, nested);
        if (inline.startsWith('[')) return flowList(inline);
        if (inline.startsWith('{')) return null;
        return scalar(inline);
    }
    if (nested.length === 0) return null;
    if (!nested.every((line) => LIST_ITEM.test(line))) return null;
    const items = nested.map((line) => scalar(LIST_ITEM.exec(line)?.[1] ?? ''));
    return items.every((item) => typeof item === 'string') ? (items as string[]) : null;
}

/** `|` or `>` and the indented lines under it, as one string. */
function block(indicator: string, nested: string[]): string {
    const lines = nested.map((line) => line.trim());
    return indicator.startsWith('>') ? lines.join(' ') : lines.join('\n');
}

/** `[a, "b, c", 'd']` on one line. Anything nested in it is not read. */
function flowList(text: string): string[] | null {
    if (!text.endsWith(']')) return null;
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];

    const items: string[] = [];
    let current = '';
    let quote: string | null = null;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            current += ch;
            if (ch === '\\' && quote === '"') {
                current += inner[++i] ?? '';
            } else if (ch === quote) {
                quote = null;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
        } else if (ch === ',') {
            items.push(current);
            current = '';
        } else if (ch === '[' || ch === '{') {
            return null;
        } else {
            current += ch;
        }
    }
    items.push(current);

    const values = items.map((item) => scalar(item.trim()));
    return values.every((value) => typeof value === 'string') ? (values as string[]) : null;
}

/** One scalar: double-quoted, single-quoted or plain. */
function scalar(text: string): string | null {
    if (text.startsWith('"')) return doubleQuoted(text);
    if (text.startsWith("'")) return singleQuoted(text);
    // In a plain scalar, a `#` after a space starts a comment.
    return text.replace(/[ \t]+#.*$/, '').trim();
}

function singleQuoted(text: string): string | null {
    let out = '';
    for (let i = 1; i < text.length; i++) {
        if (text[i] !== "'") {
            out += text[i];
        } else if (text[i + 1] === "'") {
            out += "'";
            i++;
        } else {
            return out;
        }
    }
    return null;
}

const ESCAPES: Record<string, string> = {
    '0': '\0',
    t: '\t',
    n: '\n',
    r: '\r',
    ' ': ' ',
    '"': '"',
    '/': '/',
    '\\': '\\',
    _: ' ',
};

function doubleQuoted(text: string): string | null {
    let out = '';
    for (let i = 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') return out;
        if (ch !== '\\') {
            out += ch;
            continue;
        }
        const next = text[++i] ?? '';
        const width = next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0;
        if (width > 0) {
            const hex = text.slice(i + 1, i + 1 + width);
            const code = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : NaN;
            if (hex.length === width && code <= 0x10ffff) {
                out += String.fromCodePoint(code);
                i += width;
                continue;
            }
        }
        out += ESCAPES[next] ?? next;
    }
    return null;
}
