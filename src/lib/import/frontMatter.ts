/**
 * The block of YAML a Markdown file can open with, read for its values.
 *
 * Front matter is where the exporter writes a note's title and tags, and where
 * Obsidian, Jekyll, Hugo and most other tools keep theirs. This is not a YAML
 * parser. It reads the part of YAML front matter is written in: `key: value`
 * at the top level, quoted or plain, lists written `[a, b]` (on one line or
 * several, as Prettier wraps a long one) or as `- a` lines under their key,
 * and folded or literal blocks. A value in any other shape, a nested map for
 * one, reads as null rather than as something it is not, and only the values
 * a note has a place for are ever asked for.
 *
 * The file is picked by the user but written by anyone, so every pattern here
 * is one a regular expression engine runs in linear time: no two quantifiers
 * that can both match the same run of spaces.
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
/** `key: value` or `key:` at the top level; both halves are trimmed after. */
const KEY_LINE = /^([^\s#'"\-:[{][^:]*):(?:[ \t]+(.*))?$/;
/** `- item`, at any indentation. */
const LIST_ITEM = /^[ \t]*-(?:[ \t]+(.*))?$/;

function isBlankOrComment(line: string): boolean {
    const text = line.trim();
    return text === '' || text.startsWith('#');
}

function isIndented(line: string): boolean {
    return line.startsWith(' ') || line.startsWith('\t');
}

/**
 * Split a file into its front matter and the rest.
 *
 * The block has to open the file and be closed, and every line in it has to
 * be a key, a comment, or something under a key. A file that merely starts
 * with a rule and has another further down is Markdown, even when a line
 * between them happens to read `Attendees: Ann, Bob`: taking it for front
 * matter would drop the words around that line.
 */
export function splitFrontMatter(text: string): SplitFile {
    const none: SplitFile = { values: new Map(), body: text };
    const lines = text.split('\n');
    if (!DELIMITER.test(lines[0] ?? '')) return none;

    const close = lines.findIndex((line, index) => index > 0 && CLOSER.test(line));
    if (close < 0) return none;

    const block = lines.slice(1, close);
    if (!looksLikeFrontMatter(block)) return none;

    return { values: readValues(block), body: lines.slice(close + 1).join('\n') };
}

function looksLikeFrontMatter(block: string[]): boolean {
    let underKey = false;
    for (const line of block) {
        if (isBlankOrComment(line)) continue;
        if (KEY_LINE.test(line)) {
            underKey = true;
        } else if (!underKey || !(isIndented(line) || LIST_ITEM.test(line))) {
            return false;
        }
    }
    return true;
}

function readValues(lines: string[]): Map<string, FrontMatterValue> {
    const values = new Map<string, FrontMatterValue>();
    let i = 0;
    while (i < lines.length) {
        const match = KEY_LINE.exec(lines[i]);
        i++;
        if (!match) continue;
        const key = match[1].trim();
        const inline = (match[2] ?? '').trim();

        // What belongs to this key: every line up to the next key, which is
        // to say the indented ones and the list items, with the blank lines
        // and comments between them.
        const start = i;
        while (i < lines.length && !KEY_LINE.test(lines[i])) i++;
        values.set(key, valueOf(inline, lines.slice(start, i)));
    }
    return values;
}

function valueOf(inline: string, nested: string[]): FrontMatterValue {
    // After `key: ` a `#` starts a comment, so the value is what follows.
    const own = inline.startsWith('#') ? '' : inline;
    // A block keeps its comment-looking lines: in `|` and `>`, they are text.
    if (/^[|>]/.test(own)) return block(own, nested);

    const lines = nested.filter((line) => !isBlankOrComment(line));
    if (own.startsWith('[')) return flowList([own, ...lines].join(' '));
    if (own.startsWith('{')) return null;
    if (own) return scalar(own);

    if (lines.length === 0) return null;
    if (lines[0].trim().startsWith('[')) return flowList(lines.join(' '));
    if (!lines.every((line) => LIST_ITEM.test(line))) return null;
    const items = lines.map((line) => scalar((LIST_ITEM.exec(line)?.[1] ?? '').trim()));
    return items.every((item) => typeof item === 'string') ? (items as string[]) : null;
}

/** `|` or `>` and the lines under it, as one string. */
function block(indicator: string, nested: string[]): string {
    const lines = nested.map((line) => line.trim());
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return indicator.startsWith('>') ? lines.join(' ') : lines.join('\n');
}

/**
 * `[a, "b, c", 'd']`, perhaps with a comment after it. Anything nested in
 * it is not read.
 */
function flowList(text: string): string[] | null {
    const items: string[] = [];
    let current = '';
    let quote: string | null = null;
    let i = text.indexOf('[') + 1;
    for (; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            current += ch;
            if (ch === '\\' && quote === '"') {
                current += text[++i] ?? '';
            } else if (ch === quote) {
                quote = null;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
        } else if (ch === ',') {
            items.push(current);
            current = '';
        } else if (ch === ']') {
            break;
        } else if (ch === '[' || ch === '{') {
            return null;
        } else {
            current += ch;
        }
    }
    // Unclosed, or followed by something other than a comment.
    const after = text.slice(i + 1).trim();
    if (i >= text.length || (after && !after.startsWith('#'))) return null;
    items.push(current);

    // A trailing comma leaves an empty last item, which is not an item.
    const values = items.map((item) => item.trim()).filter((item) => item.length > 0);
    const read = values.map(scalar);
    return read.every((value) => typeof value === 'string') ? (read as string[]) : null;
}

/** One scalar: double-quoted, single-quoted or plain. */
function scalar(text: string): string | null {
    if (text.startsWith('"')) return doubleQuoted(text);
    if (text.startsWith("'")) return singleQuoted(text);
    // In a plain scalar, a `#` after a space starts a comment.
    const comment = text.search(/[ \t]#/);
    return (comment < 0 ? text : text.slice(0, comment)).trim();
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
    _: '\u00a0',
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
