import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { attachmentHash } from '$lib/tiptap/attachmentRef';
import { normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';

/**
 * A document, rendered as Markdown.
 *
 * Pure, and deliberately free of Tauri and of the sync layer: the same walk
 * runs over a document nobody has opened (rendered headlessly from the CRDT,
 * the way the indexer does it) and over one the editor is holding, and it has
 * to be testable without either.
 *
 * Markdown is a lossy target and this does not pretend otherwise. What it
 * keeps is what a reader outside Oyot can still use: headings, lists, tasks,
 * quotes, code, tables, images, emphasis. What it cannot keep is recorded in
 * ADR 0021: an image's display width, a table's column widths, and a document
 * link's identity, which becomes a relative link to the other note's file.
 */
export interface MarkdownOptions {
    /**
     * Where an attachment's bytes sit relative to the note being written, by
     * content hash. Returns null when this device does not hold them, in
     * which case the image is written as a reference nothing resolves rather
     * than as a link to a file that will not be in the archive.
     */
    attachmentPath: (hash: string) => string | null;
    /**
     * Where another note's file sits relative to the note being written, by
     * document id. Returns null for a link whose target is gone, which is
     * then written as plain text.
     */
    notePath: (docId: string) => string | null;
}

/** Three spaces after the marker, so a nested list indents to four. */
const BULLET_MARKER = '-   ';

export function serializeDocument(doc: ProseMirrorNode, options: MarkdownOptions): string {
    const body = blocks(doc, options);
    return body ? `${body}\n` : '';
}

// --- blocks ---------------------------------------------------------------

function blocks(parent: ProseMirrorNode, options: MarkdownOptions): string {
    const out: string[] = [];
    parent.forEach((child) => {
        const rendered = block(child, options);
        if (rendered !== null) out.push(rendered);
    });
    // One blank line between blocks. Empty ones are dropped rather than
    // collapsed, so a document padded with empty paragraphs does not export
    // as a run of blank lines.
    return out.filter((part) => part.trim().length > 0).join('\n\n');
}

function block(node: ProseMirrorNode, options: MarkdownOptions): string | null {
    switch (node.type.name) {
        case 'paragraph': {
            const text = inline(node, options);
            return text ? escapeBlockStart(text) : '';
        }
        case 'heading': {
            const level = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6);
            return `${'#'.repeat(level)} ${inline(node, options)}`;
        }
        case 'blockquote':
            return prefixLines(blocks(node, options), '> ');
        case 'codeBlock':
            return codeBlock(node);
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
            return list(node, options);
        case 'horizontalRule':
            return '---';
        case 'image':
            return image(node, options);
        case 'table':
            return table(node, options);
        default:
            // A block type this build does not know about: render what is
            // inside it rather than dropping the words on the floor.
            return node.isTextblock ? inline(node, options) : blocks(node, options);
    }
}

/**
 * A fence long enough to survive its own content.
 *
 * A code block holding a fenced example would otherwise end the block early,
 * which turns the rest of the note into code and the code into prose.
 */
function codeBlock(node: ProseMirrorNode): string {
    const content = node.textContent;
    const longest = [...content.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
    return `${fence}${language}\n${content}\n${fence}`;
}

function list(node: ProseMirrorNode, options: MarkdownOptions): string {
    const ordered = node.type.name === 'orderedList';
    const start = ordered ? Number(node.attrs.start) || 1 : 1;
    const items: string[] = [];

    node.forEach((item, _offset, index) => {
        const marker = ordered ? `${start + index}.  ` : itemMarker(item);
        const content = blocks(item, options);
        // Continuation lines line up under the marker, which is what keeps a
        // nested list nested and a second paragraph inside its item.
        items.push(marker + indentContinuation(content, ' '.repeat(marker.length)));
    });

    return items.join('\n');
}

function itemMarker(item: ProseMirrorNode): string {
    if (item.type.name !== 'taskItem') return BULLET_MARKER;
    return item.attrs.checked === true ? '-   [x] ' : '-   [ ] ';
}

function indentContinuation(text: string, indent: string): string {
    const lines = text.split('\n');
    return lines.map((line, i) => (i === 0 || line.length === 0 ? line : indent + line)).join('\n');
}

function prefixLines(text: string, prefix: string): string {
    return text
        .split('\n')
        .map((line) => (line.length === 0 ? prefix.trimEnd() : prefix + line))
        .join('\n');
}

function image(node: ProseMirrorNode, options: MarkdownOptions): string {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
    const alt = imageAlt(node);
    const hash = attachmentHash(src, node.attrs.alt);
    if (!hash) {
        // An inline data URI, which is what a document written before
        // attachments were content-addressed may still hold. Carried through
        // as it is: it needs no file beside it.
        return src ? `![${alt}](${src})` : '';
    }
    const path = options.attachmentPath(hash);
    if (!path) return `![${alt || 'missing attachment'}](oyot-attachment://${hash})`;
    return `![${alt}](${encodeLinkTarget(path)})`;
}

/**
 * An image's alt text, minus our own bookkeeping.
 *
 * `alt="oyot:<hash>"` is how older builds recorded which attachment a node
 * meant. It is an address, not a description, and writing it into the export
 * would put a hash under every image.
 */
function imageAlt(node: ProseMirrorNode): string {
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
    return alt.startsWith('oyot:') ? '' : alt;
}

function table(node: ProseMirrorNode, options: MarkdownOptions): string {
    const rows: string[][] = [];
    node.descendants((child) => {
        if (child.type.name !== 'tableRow') return true;
        const cells: string[] = [];
        child.forEach((cell) => cells.push(cellText(cell, options)));
        rows.push(cells);
        return false;
    });
    if (rows.length === 0) return '';

    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const pad = (row: string[]) => {
        const filled = [...row];
        while (filled.length < width) filled.push('');
        return `| ${filled.join(' | ')} |`;
    };

    // GFM has no table without a header row, so the first row is the header
    // whether or not it was made of header cells. A borderless table is not
    // expressible; a table whose first row reads as a header is.
    const [header, ...body] = rows;
    const divider = `| ${Array(width).fill('---').join(' | ')} |`;
    return [pad(header), divider, ...body.map(pad)].join('\n');
}

/**
 * One cell, flattened to a single line.
 *
 * A GFM cell cannot hold a block, so a cell with two paragraphs becomes one
 * with a space between them, and a pipe inside it is escaped so it does not
 * open a column that is not there.
 */
function cellText(cell: ProseMirrorNode, options: MarkdownOptions): string {
    const parts: string[] = [];
    cell.forEach((child) => parts.push(child.isTextblock ? inline(child, options) : ''));
    return parts
        .filter((part) => part.length > 0)
        .join(' ')
        .replace(/\n/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
}

// --- inline ---------------------------------------------------------------

/** Marks, innermost last, so nesting comes out in a stable order. */
const MARK_DELIMITERS: Record<string, string> = {
    bold: '**',
    italic: '*',
    strike: '~~',
};

function inline(parent: ProseMirrorNode, options: MarkdownOptions): string {
    let out = '';
    parent.forEach((child) => {
        out += inlineNode(child, options);
    });
    return out.trimEnd();
}

function inlineNode(node: ProseMirrorNode, options: MarkdownOptions): string {
    if (node.isText) return markedText(node);

    switch (node.type.name) {
        case 'hardBreak':
            // Two trailing spaces: the one line break Markdown has that does
            // not also end the paragraph.
            return '  \n';
        case 'image':
            return image(node, options);
        case TAG_NODE_NAME: {
            const name = normalizeTagName(String(node.attrs.name ?? ''));
            return name ? `#${name}` : '';
        }
        case 'documentLink':
            return documentLink(node, options);
        default:
            return inline(node, options);
    }
}

/**
 * A link to another note, as a relative link to that note's file.
 *
 * The title is the one the chip carries, which is a snapshot taken when the
 * link was inserted (see `documentIndex`), so an export made before the
 * target was renamed says the old name. The path is resolved from the id, so
 * it points at the right file either way.
 */
function documentLink(node: ProseMirrorNode, options: MarkdownOptions): string {
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
    const targetId = typeof node.attrs.targetId === 'string' ? node.attrs.targetId : '';
    const label = escapeInline(title || 'Untitled');
    const path = targetId ? options.notePath(targetId) : null;
    return path ? `[${label}](${encodeLinkTarget(path)})` : label;
}

function markedText(node: ProseMirrorNode): string {
    const raw = node.text ?? '';
    if (!raw) return '';

    const code = node.marks.some((mark) => mark.type.name === 'code');
    // Inside code, nothing is a delimiter, so the text is taken verbatim and
    // the fence is grown past the longest run of backticks it contains.
    let text = code ? inlineCode(raw) : escapeInline(raw);

    for (const name of ['strike', 'italic', 'bold']) {
        if (!node.marks.some((mark) => mark.type.name === name)) continue;
        const delimiter = MARK_DELIMITERS[name];
        // Emphasis cannot span its own surrounding spaces: `** bold **` is not
        // emphasis at all, so the padding is moved outside the delimiters.
        text = text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_m, lead, body, trail) =>
            body ? `${lead}${delimiter}${body}${delimiter}${trail}` : `${lead}${trail}`,
        );
    }

    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (link) {
        const href = typeof link.attrs.href === 'string' ? link.attrs.href : '';
        if (href) text = `[${text}](${encodeLinkTarget(href)})`;
    }

    return text;
}

function inlineCode(text: string): string {
    const longest = [...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
    const fence = '`'.repeat(longest + 1);
    // A space is needed when the content itself starts or ends with a
    // backtick, or the fences merge into it.
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Characters that would otherwise be read as markup.
 *
 * Deliberately not `_`: intra-word underscores are not emphasis in CommonMark,
 * and escaping them turns every `snake_case` identifier in a note into
 * `snake\_case` for a reader who does not render the file.
 */
function escapeInline(text: string): string {
    return text.replace(/([\\`*[\]<>])/g, '\\$1');
}

/**
 * A line that would be read as the start of a block, when it is meant as
 * prose: a paragraph that happens to begin "1. " or "- " or "#".
 */
function escapeBlockStart(text: string): string {
    return text.replace(
        /^(\s*)([#>|+-]|\d+[.)])(?=\s|$)/,
        (_m, lead, marker) => `${lead}\\${marker}`,
    );
}

/**
 * A link target that survives being written between parentheses.
 *
 * Spaces and parentheses are what actually break a Markdown link, and a note
 * title becomes a filename, so both turn up. Angle brackets would be the other
 * option; percent-encoding is what a file manager and a Markdown editor both
 * follow back to the file.
 */
function encodeLinkTarget(target: string): string {
    return target.replace(/[ ()<>"']/g, (char) => encodeURIComponent(char));
}
