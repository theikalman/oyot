import markdownit, { type MarkdownIt, type StateInline, type Token } from 'markdown-it';
import {
    Mark,
    type Attrs,
    type Node as ProseMirrorNode,
    type NodeType,
    type Schema,
} from '@tiptap/pm/model';
import { ATTACHMENT_SCHEME, attachmentHash } from '$lib/tiptap/attachmentRef';
import { MAX_TAG_LENGTH, normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';

/**
 * Markdown, read into a document the editor can open.
 *
 * The other direction from `$lib/export/markdown`, and written as its mirror:
 * what the exporter writes, this reads back into the same nodes, so a note
 * exported and imported again comes back as it was, less what Markdown could
 * not carry in the first place (ADR 0021).
 *
 * Pure, like the exporter, and for the same reason: it has to be testable
 * without Tauri, the sync layer or a DOM. markdown-it does the parsing, which
 * is CommonMark plus GitHub's tables, strikethrough and bare links. This walks
 * its tokens and builds nodes against the editor's schema directly, so what
 * comes out is a document the editor could have made, or an error, and never
 * something in between.
 *
 * What a note cannot hold is kept as the text it was written as rather than
 * dropped: HTML, and an image there is nothing to show for. The reader can see
 * what was there, and nothing in the file is lost by being imported. See
 * docs/decisions/0029-import-markdown-files-as-notes.md.
 */

/** A note another link can point at, by id. */
export interface NoteLinkTarget {
    id: string;
    title: string;
}

/** What an image is stored as. */
export interface StoredImage {
    src: string;
    alt: string | null;
}

export interface MarkdownReadOptions {
    /**
     * Tag names to recognise as written, normalized.
     *
     * `#name` ends at the first character a tag cannot hold, so a tag with a
     * space in it can only be told from the words after it by knowing its
     * name already. A note's front matter is where those names are, and it is
     * where the exporter puts them.
     */
    knownTags?: readonly string[];
    /**
     * The note a link's address names, when that note is being imported
     * alongside this one. Null leaves the link a link.
     */
    noteLink?: (href: string) => NoteLinkTarget | null;
    /**
     * What to store for an image, or null to keep it as the Markdown it was
     * written as. Defaults to `storedImage`.
     */
    imageSource?: (src: string, alt: string) => StoredImage | null;
}

export interface MarkdownDocument {
    doc: ProseMirrorNode;
    /** Images kept as their Markdown, because there was nothing to show. */
    imagesKeptAsText: number;
}

/** The first block, when it is a top-level heading. */
export interface LeadingHeading {
    /** Its words, as plain text on one line. */
    text: string;
    /** The source lines it spans, `[first, last + 1)`. */
    lines: [number, number];
}

// --- the parser -------------------------------------------------------------

/**
 * How the known tags reach the tag rule, which only sees markdown-it's state.
 * A type rather than an interface, so it fits markdown-it's open-ended `Env`.
 */
type TagEnv = {
    oyotKnownTags: readonly string[];
};

let parser: MarkdownIt | null = null;

function markdownParser(): MarkdownIt {
    if (parser) return parser;
    const md = markdownit('default', {
        // Recognised so that `<br>` can be a line break. Every other tag is
        // kept as the text it is (see `DocumentReader.inline`).
        html: true,
        // A bare web address becomes a link, as GitHub makes it one.
        // linkify-it 6 does not link a bare domain, which matters here:
        // `.md` is a country's domain, and `notes.md` is a file name.
        linkify: true,
        // Quotes and dashes stay as the writer typed them.
        typographer: false,
    });
    md.inline.ruler.push('oyot_tag', tagRule);
    parser = md;
    return md;
}

function parse(markdown: string, knownTags: readonly string[]): Token[] {
    // Longest first, so `#house move` is not taken for `#house`.
    const env: TagEnv = { oyotKnownTags: [...knownTags].sort((a, b) => b.length - a.length) };
    return markdownParser().parse(markdown, env);
}

// --- tags ---------------------------------------------------------------------

/**
 * What a tag written as `#name` can be made of: letters with their combining
 * marks, digits, `_`, `-` and `/`. The same set Obsidian and Bear use, so
 * their notes' tags come across whole.
 */
const TAG_CHAR = /^[\p{L}\p{M}\p{N}_\-/]$/u;
const LETTER = /\p{L}/u;

/**
 * What may stand before a tag's `#`: a space, or what opens emphasis, a
 * bracket or a quote, so `**#urgent**` and `(#home)` are tags.
 */
const BEFORE_TAG = /^[\s*_~([{"'“‘]$/u;

/**
 * `#name` as a tag, when the `#` begins a word.
 *
 * After a letter or a digit a `#` is part of the word (`C#`), and after a
 * slash it is part of an address (`page/#section`). A name with no letter in
 * it is not a tag either, which keeps `issue #42` and `#1 priority` as the
 * words they are. Inside a link's words the rule stands aside: a chip inside
 * a link has no meaning.
 *
 * A backslash before the `#`, or code around it, reaches here as markdown-it's
 * own tokens, so an escaped hash never becomes a tag.
 */
function tagRule(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x23 /* # */) return false;
    if (state.linkLevel > 0) return false;
    if (start > 0 && !BEFORE_TAG.test(state.src[start - 1])) return false;

    const known = (state.env as Partial<TagEnv>).oyotKnownTags ?? [];
    const written = tagAt(state.src, start + 1, state.posMax, known);
    if (written === null) return false;

    if (!silent) {
        const token = state.push('oyot_tag', '', 0);
        token.content = `#${written}`;
        token.meta = { name: normalizeTagName(written) };
    }
    state.pos = start + 1 + written.length;
    return true;
}

/** The tag name written at `from`, as written, or null if there is none. */
function tagAt(src: string, from: number, max: number, known: readonly string[]): string | null {
    // A name the front matter gave, followed by something that cannot
    // continue it: how a tag with a space in it is recognised.
    for (const name of known) {
        const end = from + name.length;
        if (end > max || src.slice(from, end).toLowerCase() !== name) continue;
        if (end < max && isTagChar(src, end)) continue;
        return src.slice(from, end);
    }

    let end = from;
    while (end < max && isTagChar(src, end)) {
        end += String.fromCodePoint(src.codePointAt(end) ?? 0).length;
    }
    const word = src.slice(from, end);
    if (!word || word.length > MAX_TAG_LENGTH || !LETTER.test(word)) return null;
    return word;
}

function isTagChar(src: string, at: number): boolean {
    return TAG_CHAR.test(String.fromCodePoint(src.codePointAt(at) ?? 0));
}

// --- images ---------------------------------------------------------------------

/** The inline images the editor shows as they are. */
const RASTER_DATA_URI = /^data:image\/(png|jpeg|gif|webp);/i;

/**
 * What to store for an image, by where it points.
 *
 * An inline data URI is kept as it is: the editor shows one, and the exporter
 * writes one back out unchanged. An address that names an attachment by its
 * content hash, which is what `oyot-attachment://` is and what the exporter's
 * `attachments/<hash>.<ext>` files are called, is stored the way the editor
 * stores an image it inserted, so it shows as soon as this device, or one it
 * syncs with, holds those bytes.
 *
 * Anything else is a file beside the note or a web address. The first is not
 * read, because the webview may not name a file (see `commands/import.rs`),
 * and the second is not shown, because the content security policy keeps
 * notes from loading anything off the network. Both are kept as text.
 */
export function storedImage(src: string, alt: string): StoredImage | null {
    if (RASTER_DATA_URI.test(src)) return { src, alt: alt || null };
    const hash = attachmentHash(src, alt);
    if (!hash) return null;
    // `oyot:<hash>` is the alt the editor gives an image it inserts; a real
    // description is kept instead when the file has one.
    const described = alt && !alt.startsWith('oyot:');
    return { src: `${ATTACHMENT_SCHEME}${hash}`, alt: described ? alt : `oyot:${hash}` };
}

/** An image as Markdown writes it, for one kept as text. */
function imageMarkdown(src: string, alt: string, title: string): string {
    const titled = title ? ` "${title.replace(/(["\\])/g, '\\$1')}"` : '';
    return `![${alt}](${src}${titled})`;
}

// --- reading --------------------------------------------------------------------

/**
 * Read `markdown` into a document in `schema`.
 *
 * Throws only if the document built would not be valid in the schema, which
 * would be a bug here: every construct Markdown has is given a place.
 */
export function readMarkdown(
    markdown: string,
    schema: Schema,
    options: MarkdownReadOptions = {},
): MarkdownDocument {
    const reader = new DocumentReader(schema, {
        noteLink: options.noteLink ?? (() => null),
        imageSource: options.imageSource ?? storedImage,
    });
    const doc = reader.document(parse(markdown, options.knownTags ?? []));
    doc.check();
    return { doc, imagesKeptAsText: reader.imagesKeptAsText };
}

/**
 * The document's first block, when it is a top-level heading.
 *
 * A note's title is not part of its content in Oyot, and a Markdown file
 * usually says what it is called in a heading at the top. The exporter writes
 * one there for that reason.
 */
export function leadingHeading(
    markdown: string,
    knownTags: readonly string[] = [],
): LeadingHeading | null {
    const [open, inline] = parse(markdown, knownTags);
    if (open?.type !== 'heading_open' || open.tag !== 'h1' || !open.map) return null;
    if (inline?.type !== 'inline') return null;
    return { text: oneLine(plainText(inline.children ?? [])), lines: open.map };
}

/** Inline tokens as the words they say. */
function plainText(tokens: Token[]): string {
    let out = '';
    for (const token of tokens) {
        if (token.type === 'softbreak' || token.type === 'hardbreak') out += ' ';
        else if (token.type === 'image') out += plainText(token.children ?? []);
        else if (token.type === 'html_inline' && BREAK_TAG.test(token.content)) out += ' ';
        else out += token.content;
    }
    return out;
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** `<br>`, `<br/>` and `<br />`: the one piece of HTML with a place in a note. */
const BREAK_TAG = /^<br\s*\/?>$/i;

/** A block token and what it holds, from markdown-it's flat open/close list. */
interface Branch {
    token: Token;
    children: Branch[];
}

function nest(tokens: Token[]): Branch[] {
    const root: Branch[] = [];
    const stack: Branch[][] = [root];
    for (const token of tokens) {
        const siblings = stack[stack.length - 1];
        if (token.nesting === 1) {
            const branch: Branch = { token, children: [] };
            siblings.push(branch);
            stack.push(branch.children);
        } else if (token.nesting === -1) {
            if (stack.length > 1) stack.pop();
        } else {
            siblings.push({ token, children: [] });
        }
    }
    return root;
}

/** The inline tokens of a paragraph, a heading or a table cell. */
function inlineOf(children: Branch[]): Token[] {
    return children.find((child) => child.token.type === 'inline')?.token.children ?? [];
}

class DocumentReader {
    imagesKeptAsText = 0;

    constructor(
        private readonly schema: Schema,
        private readonly options: Required<Omit<MarkdownReadOptions, 'knownTags'>>,
    ) {}

    document(tokens: Token[]): ProseMirrorNode {
        return this.schema.topNodeType.create(null, this.nonEmpty(this.blocks(nest(tokens))));
    }

    private blocks(branches: Branch[]): ProseMirrorNode[] {
        return branches.flatMap((branch) => this.block(branch));
    }

    private block({ token, children }: Branch): ProseMirrorNode[] {
        const { nodes } = this.schema;
        switch (token.type) {
            case 'paragraph_open':
                return this.textblock(nodes.paragraph, null, inlineOf(children));
            case 'heading_open': {
                const level = Math.min(Math.max(Number(token.tag.slice(1)) || 1, 1), 6);
                return this.textblock(nodes.heading, { level }, inlineOf(children));
            }
            case 'blockquote_open':
                return [nodes.blockquote.create(null, this.nonEmpty(this.blocks(children)))];
            case 'bullet_list_open':
            case 'ordered_list_open':
                return this.list(token, children);
            case 'fence':
            case 'code_block':
                return [this.codeBlock(token)];
            case 'hr':
                return [nodes.horizontalRule.create()];
            case 'html_block':
                return [this.htmlBlock(token)];
            case 'table_open':
                return this.table(children);
            case 'inline':
                return this.textblock(nodes.paragraph, null, token.children ?? []);
            default:
                // A block this reader was not written for: keep what is in
                // it rather than dropping the words on the floor.
                return this.blocks(children);
        }
    }

    /** At least one block, where the schema requires one. */
    private nonEmpty(blocks: ProseMirrorNode[]): ProseMirrorNode[] {
        return blocks.length > 0 ? blocks : [this.schema.nodes.paragraph.create()];
    }

    /**
     * A paragraph or a heading, split wherever an image stands in it.
     *
     * Markdown puts an image in a line of text, and the editor's image is a
     * block of its own, so a line with an image in it becomes the words
     * before it, the image, and the words after.
     */
    private textblock(type: NodeType, attrs: Attrs | null, tokens: Token[]): ProseMirrorNode[] {
        const pieces = this.inline(tokens);
        if (!pieces.some((piece) => piece.isBlock)) return [type.create(attrs, pieces)];

        const out: ProseMirrorNode[] = [];
        let run: ProseMirrorNode[] = [];
        const endRun = () => {
            const words = this.trimmed(run);
            if (words.length > 0) out.push(type.create(attrs, words));
            run = [];
        };
        for (const piece of pieces) {
            if (!piece.isBlock) {
                run.push(piece);
                continue;
            }
            endRun();
            out.push(piece);
        }
        endRun();
        return out;
    }

    /** A run of inline nodes without the spaces and breaks at either end. */
    private trimmed(run: ProseMirrorNode[]): ProseMirrorNode[] {
        const nodes = [...run];
        // Trims the node at `index`, and says whether it went entirely, in
        // which case the next one in has to be looked at too.
        const trimAway = (index: number, side: 'start' | 'end'): boolean => {
            const node = nodes[index];
            if (node.type.name === 'hardBreak') {
                nodes.splice(index, 1);
                return true;
            }
            if (!node.isText) return false;
            const text = side === 'start' ? node.text!.trimStart() : node.text!.trimEnd();
            if (!text) {
                nodes.splice(index, 1);
                return true;
            }
            nodes[index] = this.schema.text(text, node.marks);
            return false;
        };
        while (nodes.length > 0 && trimAway(0, 'start'));
        while (nodes.length > 0 && trimAway(nodes.length - 1, 'end'));
        return nodes;
    }

    /**
     * The inline content of a block, as nodes, with any image as the block
     * node it becomes.
     */
    private inline(tokens: Token[]): ProseMirrorNode[] {
        const { schema } = this;
        const out: ProseMirrorNode[] = [];
        const active: Mark[] = [];
        const text = (content: string, marks: readonly Mark[] = markSet(active)) => {
            if (content) out.push(schema.text(content, marks));
        };

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            switch (token.type) {
                case 'text':
                case 'text_special':
                    text(token.content);
                    break;
                case 'softbreak':
                    // Where the file wrapped, not where the writer broke the
                    // line: Markdown reads it as a space, and so does this.
                    text(' ');
                    break;
                case 'hardbreak':
                    out.push(schema.nodes.hardBreak.create());
                    break;
                case 'code_inline':
                    text(token.content, codeMarks(active, schema));
                    break;
                case 'strong_open':
                    active.push(schema.marks.bold.create());
                    break;
                case 'em_open':
                    active.push(schema.marks.italic.create());
                    break;
                case 's_open':
                    active.push(schema.marks.strike.create());
                    break;
                case 'strong_close':
                    dropLast(active, 'bold');
                    break;
                case 'em_close':
                    dropLast(active, 'italic');
                    break;
                case 's_close':
                    dropLast(active, 'strike');
                    break;
                case 'link_open': {
                    const href = String(token.attrGet('href') ?? '');
                    const target = href ? this.options.noteLink(href) : null;
                    if (target) {
                        // A link to another note being imported is a link to
                        // that note, the chip the editor inserts. Its words
                        // give way to the note's title, which is what the
                        // exporter wrote there.
                        out.push(
                            schema.nodes.documentLink.create(
                                { targetId: target.id, title: target.title },
                                null,
                                markSet(active),
                            ),
                        );
                        i = closingLink(tokens, i);
                    } else {
                        const title = String(token.attrGet('title') ?? '');
                        active.push(schema.marks.link.create({ href, title: title || null }));
                    }
                    break;
                }
                case 'link_close':
                    dropLast(active, 'link');
                    break;
                case 'image':
                    out.push(this.image(token, active));
                    break;
                case 'html_inline':
                    if (BREAK_TAG.test(token.content)) {
                        out.push(schema.nodes.hardBreak.create());
                    } else {
                        text(token.content.replace(/\s*\n\s*/g, ' '));
                    }
                    break;
                case 'oyot_tag': {
                    const name = String(token.meta?.name ?? '');
                    if (name) {
                        out.push(
                            schema.nodes[TAG_NODE_NAME].create({ name }, null, markSet(active)),
                        );
                    } else {
                        text(token.content);
                    }
                    break;
                }
                default:
                    // A token this reader was not written for: keep its words.
                    text(token.content);
            }
        }
        return out;
    }

    private image(token: Token, active: readonly Mark[]): ProseMirrorNode {
        const src = String(token.attrGet('src') ?? '');
        const alt = plainText(token.children ?? []).trim();
        const title = String(token.attrGet('title') ?? '');
        const stored = src ? this.options.imageSource(src, alt) : null;
        if (stored) {
            return this.schema.nodes.image.create({ ...stored, title: title || null });
        }
        this.imagesKeptAsText++;
        return this.schema.text(imageMarkdown(src, alt, title), markSet(active));
    }

    /**
     * A list, or several.
     *
     * GitHub lets one list mix task items with plain ones, and the editor
     * cannot: a task list holds only tasks. So a mixed list becomes a run of
     * lists, one per stretch of items of the same kind, in the same order. An
     * ordered list split that way keeps counting where it left off.
     */
    private list(open: Token, items: Branch[]): ProseMirrorNode[] {
        const { nodes } = this.schema;
        const ordered = open.type === 'ordered_list_open';
        let number = ordered ? Number(open.attrGet('start') ?? 1) || 1 : 1;

        const out: ProseMirrorNode[] = [];
        let task = false;
        let start = number;
        let run: ProseMirrorNode[] = [];
        const endRun = () => {
            if (run.length === 0) return;
            if (task) out.push(nodes.taskList.create(null, run));
            else if (ordered) out.push(nodes.orderedList.create({ start }, run));
            else out.push(nodes.bulletList.create(null, run));
            run = [];
        };

        for (const item of items) {
            if (item.token.type !== 'list_item_open') continue;
            const checked = takeTaskMarker(item.children);
            if (run.length > 0 && (checked !== null) !== task) endRun();
            if (run.length === 0) {
                task = checked !== null;
                start = number;
            }
            const content = this.itemContent(this.blocks(item.children));
            run.push(
                checked !== null
                    ? nodes.taskItem.create({ checked }, content)
                    : nodes.listItem.create(null, content),
            );
            number++;
        }
        endRun();
        return out;
    }

    /**
     * What a list item can hold: a paragraph first, then any blocks. An item
     * with nothing in it, or one that opens with a heading, a code block or an
     * image, gets an empty paragraph in front, which is where the editor puts
     * the caret in an item of its own.
     */
    private itemContent(blocks: ProseMirrorNode[]): ProseMirrorNode[] {
        const { paragraph } = this.schema.nodes;
        return blocks[0]?.type === paragraph ? blocks : [paragraph.create(), ...blocks];
    }

    private codeBlock(token: Token): ProseMirrorNode {
        const { schema } = this;
        const content = token.content.replace(/\n$/, '');
        const info = token.type === 'fence' ? markdownParser().utils.unescapeAll(token.info) : '';
        const language = info.trim().split(/\s+/)[0] || null;
        return schema.nodes.codeBlock.create({ language }, content ? schema.text(content) : null);
    }

    /**
     * A block of HTML, kept as the text it is, a line for a line. A note has
     * no HTML, and rendering it would be turning it into something the note
     * cannot keep.
     */
    private htmlBlock(token: Token): ProseMirrorNode {
        const { schema } = this;
        const content: ProseMirrorNode[] = [];
        token.content
            .replace(/\n+$/, '')
            .split('\n')
            .forEach((line, index) => {
                if (index > 0) content.push(schema.nodes.hardBreak.create());
                if (line) content.push(schema.text(line));
            });
        return schema.nodes.paragraph.create(null, content);
    }

    private table(sections: Branch[]): ProseMirrorNode[] {
        const { nodes } = this.schema;
        const rows = sections.flatMap((section) =>
            section.token.type === 'tr_open' ? [section] : section.children,
        );
        const built = rows
            .filter((row) => row.token.type === 'tr_open')
            .map((row) =>
                nodes.tableRow.create(
                    null,
                    row.children
                        .filter(
                            (cell) =>
                                cell.token.type === 'th_open' || cell.token.type === 'td_open',
                        )
                        .map((cell) => {
                            const type =
                                cell.token.type === 'th_open' ? nodes.tableHeader : nodes.tableCell;
                            const align = cellAlign(cell.token);
                            const content = this.nonEmpty(
                                this.textblock(nodes.paragraph, null, inlineOf(cell.children)),
                            );
                            return type.create(align ? { align } : null, content);
                        }),
                ),
            );
        return built.length > 0 ? [nodes.table.create(null, built)] : [];
    }
}

/** Where a link's tokens end, so a link that became a chip can skip its words. */
function closingLink(tokens: Token[], open: number): number {
    for (let i = open + 1; i < tokens.length; i++) {
        if (tokens[i].type === 'link_close') return i;
    }
    return tokens.length - 1;
}

/**
 * GitHub's task list rule: an item is a task when its first paragraph begins
 * `[ ]` or `[x]`. The marker comes off the words, since the checkbox says it.
 */
function takeTaskMarker(children: Branch[]): boolean | null {
    const [first] = children;
    if (first?.token.type !== 'paragraph_open') return null;
    const lead = inlineOf(first.children)[0];
    if (lead?.type !== 'text') return null;
    const marker = /^\[([ xX])\](?:[ \t]+|$)/.exec(lead.content);
    if (!marker) return null;
    lead.content = lead.content.slice(marker[0].length);
    return marker[1] !== ' ';
}

/** A column's alignment, which markdown-it writes as a style. */
function cellAlign(token: Token): 'left' | 'center' | 'right' | null {
    const style = String(token.attrGet('style') ?? '');
    const match = /text-align:\s*(left|center|right)/.exec(style);
    return (match?.[1] as 'left' | 'center' | 'right' | undefined) ?? null;
}

/** The marks in force, as a set the schema accepts. */
function markSet(active: readonly Mark[]): readonly Mark[] {
    let set: readonly Mark[] = Mark.none;
    for (const mark of active) set = mark.addToSet(set);
    return set;
}

/**
 * The marks for inline code.
 *
 * The schema's code mark excludes every other, so adding it drops the rest.
 * A link is the exception: its address is information and code's typeface is
 * not, so inside a link it is the code mark that goes.
 */
function codeMarks(active: readonly Mark[], schema: Schema): readonly Mark[] {
    if (active.some((mark) => mark.type.name === 'link')) return markSet(active);
    return markSet([...active, schema.marks.code.create()]);
}

function dropLast(active: Mark[], name: string): void {
    for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].type.name === name) {
            active.splice(i, 1);
            return;
        }
    }
}
