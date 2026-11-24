import type { Attrs, Mark, Node as ProseMirrorNode, NodeType, Schema } from '@tiptap/pm/model';
import { codeMarks, lists, markSet, nonEmpty, textblocks, trimmed, type ListItem } from './build';
import { embeddedRaster } from './embeddedImages';
import { imageMarkdown, oneLine, storedImage, type NoteLinkTarget } from './markdown';

/**
 * An HTML file, read into a document the editor can open.
 *
 * The browser's own parser reads the file, into a document that is never put
 * on a page: it runs no script and loads nothing. This walks what it made and
 * builds nodes against the editor's schema directly, as the Markdown reader
 * does, so what comes out is a document the editor could have made.
 *
 * A page is laid out and a note is written, so this keeps what the page says
 * and not how it looked. An element that only arranges others gives way to
 * what is inside it, words keep the emphasis a note has, and what is not
 * content, scripts and styles, is not read. What is content and has no place
 * in a note, a drawing or a player, is counted so the user is told. See
 * docs/decisions/0042-import-html-files-as-editable-notes.md.
 */

export interface HtmlReadOptions {
    /** The note an `href` points at, when it names a file imported with this one. */
    noteLink?: (href: string) => NoteLinkTarget | null;
}

export interface HtmlDocument {
    doc: ProseMirrorNode;
    /** Images kept as their Markdown, because there was nothing to show. */
    imagesKeptAsText: number;
    /** Drawings, players and pictures that had to be left out. */
    leftOut: number;
}

/** Elements that hold nothing a reader of the page sees as its content. */
const NOT_CONTENT = new Set([
    'base',
    'datalist',
    'head',
    'input',
    'link',
    'meta',
    'noscript',
    'rp',
    'script',
    'select',
    'source',
    'style',
    'template',
    'title',
    'track',
]);

/** Elements that start on a line of their own, and end one. */
const BLOCKS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'caption',
    'center',
    'dd',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'header',
    'hgroup',
    'html',
    'legend',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'p',
    'pre',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);

/** Elements that show something from elsewhere, or draw it. */
const PLAYERS = new Set(['audio', 'embed', 'iframe', 'object', 'video']);

/** The marks an element gives what is inside it. */
const MARKS: Record<string, string> = {
    b: 'bold',
    strong: 'bold',
    i: 'italic',
    em: 'italic',
    cite: 'italic',
    dfn: 'italic',
    var: 'italic',
    u: 'underline',
    ins: 'underline',
    s: 'strike',
    strike: 'strike',
    del: 'strike',
};

const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

/**
 * The most cells a table is kept as one with. A table's cells are padded out
 * to a full grid, and a short file can claim a grid far larger than itself.
 */
const MAX_CELLS = 50_000;
const MAX_COLSPAN = 100;

const ELEMENT = 1;
const TEXT = 3;

/** What an element inherits from those around it. */
interface Context {
    marks: readonly Mark[];
    code: boolean;
}

/** Parse a file. Nothing in it runs, and nothing it names is loaded. */
export function parseHtml(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * What a page is called: its `<title>`, else its first heading at the top
 * level. Empty when it has neither.
 */
export function htmlTitle(page: Document): string {
    const given = oneLine(page.title);
    if (given) return given;
    const headings = [...page.querySelectorAll('h1')];
    const heading = headings.find((h1) => !hidden(h1) && oneLine(h1.textContent ?? ''));
    return oneLine(heading?.textContent ?? '');
}

/**
 * Read a page into a document in `schema`.
 *
 * An image inside the file is left as the data URI it is, for the caller to
 * store: see ./embeddedImages. Throws only if the document built would not be
 * valid in the schema, which would be a bug here.
 */
export function readHtml(
    page: Document,
    schema: Schema,
    options: HtmlReadOptions = {},
): HtmlDocument {
    const reader = new PageReader(page, schema, options.noteLink ?? (() => null));
    const doc = reader.document();
    doc.check();
    return { doc, imagesKeptAsText: reader.imagesKeptAsText, leftOut: reader.leftOut };
}

/**
 * Blocks being gathered, and the line of text being written.
 *
 * An inline element can hold a block, and a block can have loose text beside
 * it, so a line ends where a block begins rather than where an element does.
 */
class Flow {
    readonly blocks: ProseMirrorNode[] = [];
    private line: ProseMirrorNode[] = [];

    constructor(
        private readonly schema: Schema,
        private readonly type: NodeType = schema.nodes.paragraph,
        private readonly attrs: Attrs | null = null,
    ) {}

    /** Text as HTML writes it, where any run of white space is one space. */
    text(content: string, marks: readonly Mark[]): void {
        let text = content.replace(/[ \t\n\r\f]+/g, ' ');
        if (text.startsWith(' ') && this.afterSpace()) text = text.slice(1);
        if (text) this.line.push(this.schema.text(text, marks));
    }

    /** An inline node, or an image, which the line is split around. */
    piece(node: ProseMirrorNode): void {
        this.line.push(node);
    }

    block(...nodes: ProseMirrorNode[]): void {
        this.endLine();
        this.blocks.push(...nodes);
    }

    /**
     * End the line, making a block of it.
     *
     * A line of nothing but breaks and hard spaces is a writer making room
     * between paragraphs, and becomes the empty paragraph that makes it in a
     * note. A line of nothing is the space between two tags.
     */
    endLine(): void {
        const line = this.line;
        this.line = [];
        if (line.length === 0) return;
        const words = trimmed(line);
        if (words.length > 0) {
            this.blocks.push(...textblocks(this.type, this.attrs, words));
            return;
        }
        const spacer = line.some((node) => !node.isText || node.text!.includes('\u00a0'));
        if (spacer && this.type.name === 'paragraph') this.blocks.push(this.type.create());
    }

    private afterSpace(): boolean {
        const last = this.line.at(-1);
        if (!last || last.isBlock || last.type.name === 'hardBreak') return true;
        return last.isText && last.text!.endsWith(' ');
    }
}

class PageReader {
    imagesKeptAsText = 0;
    leftOut = 0;
    private readonly base: string | null;

    constructor(
        private readonly page: Document,
        private readonly schema: Schema,
        private readonly noteLink: (href: string) => NoteLinkTarget | null,
    ) {
        const base = page.querySelector('base[href]')?.getAttribute('href') ?? '';
        this.base = /^https?:/i.test(base) ? base : null;
    }

    document(): ProseMirrorNode {
        const flow = new Flow(this.schema);
        if (this.page.body) this.children(this.page.body, flow, { marks: [], code: false });
        flow.endLine();
        return this.schema.topNodeType.create(null, nonEmpty(this.schema, flow.blocks));
    }

    /** What an element holds, as blocks of its own. */
    private blocksIn(element: Element, context: Context): ProseMirrorNode[] {
        const flow = new Flow(this.schema);
        this.children(element, flow, context);
        flow.endLine();
        return flow.blocks;
    }

    private children(element: Element, flow: Flow, context: Context): void {
        for (const child of element.childNodes) this.node(child, flow, context);
    }

    private node(node: Node, flow: Flow, context: Context): void {
        if (node.nodeType === TEXT) {
            flow.text(node.nodeValue ?? '', this.marksOf(context));
            return;
        }
        if (node.nodeType !== ELEMENT) return;
        const element = node as Element;
        const name = element.localName;
        if (NOT_CONTENT.has(name) || hidden(element)) return;

        switch (name) {
            case 'br':
                flow.piece(this.schema.nodes.hardBreak.create());
                return;
            case 'hr':
                flow.block(this.schema.nodes.horizontalRule.create());
                return;
            case 'img':
                this.image(element, flow, context);
                return;
            case 'a':
                this.link(element, flow, context);
                return;
            case 'q':
                flow.text('“', this.marksOf(context));
                this.children(element, flow, context);
                flow.text('”', this.marksOf(context));
                return;
            case 'svg':
            case 'canvas':
                if (!decorative(element)) this.leftOut++;
                return;
            case 'math':
                this.math(element, flow, context);
                return;
            case 'h1':
            case 'h2':
            case 'h3':
            case 'h4':
            case 'h5':
            case 'h6': {
                const heading = this.schema.nodes.heading;
                const inside = new Flow(this.schema, heading, { level: Number(name[1]) });
                this.children(element, inside, styled(element, context, this.schema));
                inside.endLine();
                flow.block(...inside.blocks);
                return;
            }
            case 'blockquote': {
                const inside = this.blocksIn(element, styled(element, context, this.schema));
                if (inside.length > 0)
                    flow.block(this.schema.nodes.blockquote.create(null, inside));
                return;
            }
            case 'ul':
            case 'menu':
            case 'dir':
            case 'ol':
                flow.block(...this.list(element, context));
                return;
            case 'pre':
                flow.block(...this.codeBlock(element));
                return;
            case 'table':
                flow.endLine();
                this.table(element, flow, context);
                return;
        }
        if (PLAYERS.has(name)) {
            this.player(element, flow, context);
            return;
        }

        const inside = styled(element, context, this.schema);
        if (!BLOCKS.has(name)) {
            this.children(element, flow, inside);
            return;
        }
        flow.endLine();
        this.children(element, flow, inside);
        flow.endLine();
    }

    private marksOf({ marks, code }: Context): readonly Mark[] {
        return code ? codeMarks(marks, this.schema) : markSet(marks);
    }

    // --- links --------------------------------------------------------------

    private link(element: Element, flow: Flow, context: Context): void {
        const inside = styled(element, context, this.schema);
        const href = element.getAttribute('href')?.trim() ?? '';
        const target = href ? this.noteLink(href) : null;
        if (target) {
            // As the Markdown reader does: a link that only says the note's
            // title is the chip, and other words stay with the chip after.
            const words = oneLine(element.textContent ?? '');
            const image = element.querySelector('img') !== null;
            const title = oneLine(target.title);
            const onlyTitle = !words || words.toLocaleLowerCase() === title.toLocaleLowerCase();
            if (image || !onlyTitle) {
                this.children(element, flow, inside);
                flow.text(' ', this.marksOf(context));
            }
            flow.piece(
                this.schema.nodes.documentLink.create(
                    { targetId: target.id, title: target.title },
                    null,
                    markSet(context.marks),
                ),
            );
            return;
        }

        const address = this.address(href);
        if (!address) {
            this.children(element, flow, inside);
            return;
        }
        const title = oneLine(element.getAttribute('title') ?? '');
        this.children(element, flow, withLink(inside, address, title || null, this.schema));
    }

    /**
     * An address to keep in a link, or null for one that leads nowhere from a
     * note: within the page, or in a scheme that is not for reading, a script
     * for one.
     */
    private address(href: string): string | null {
        // As a browser reads it, which is past any control character: a
        // scheme broken by a tab is still that scheme.
        // eslint-disable-next-line no-control-regex
        const written = href.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (!written || written.startsWith('#')) return null;
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(written)?.[1].toLowerCase();
        if (scheme) return LINK_SCHEMES.has(scheme) ? written : null;
        return this.resolved(written);
    }

    /** A relative address made whole, when the page says what it is relative to. */
    private resolved(address: string): string {
        if (!this.base) return address;
        try {
            return new URL(address, this.base).href;
        } catch {
            return address;
        }
    }

    // --- what is shown rather than said -------------------------------------

    /**
     * An image: the picture itself when it is inside the file or an
     * attachment, and otherwise its Markdown, as in a Markdown file.
     */
    private image(element: Element, flow: Flow, context: Context): void {
        const tiny = (side: string) => {
            const value = element.getAttribute(side);
            return value !== null && Number.parseInt(value, 10) <= 1;
        };
        // A pixel that counts who opened a page is not a picture in it.
        if (tiny('width') && tiny('height')) return;

        const src = imageSource(element);
        const alt = oneLine(element.getAttribute('alt') ?? '');
        const title = oneLine(element.getAttribute('title') ?? '');
        const marks = this.marksOf(context);

        const raster = embeddedRaster(src);
        // An address on the web is never an attachment, whatever it looks like.
        const stored = raster
            ? { src: raster, alt: alt || null }
            : /^(https?:)?\/\//i.test(src)
              ? null
              : storedImage(src, alt);
        if (stored) {
            flow.piece(this.schema.nodes.image.create({ ...stored, title: title || null }));
            return;
        }
        if (!src || /^(data|blob|cid|about):/i.test(src)) {
            // Nothing that could be shown, and no address worth reading.
            if (src) this.leftOut++;
            flow.text(alt, marks);
            return;
        }
        this.imagesKeptAsText++;
        const scheme = /^[a-z][a-z0-9+.-]*:/i.test(src);
        const written = imageMarkdown(scheme ? src : this.resolved(src), alt, title);
        flow.piece(this.schema.text(written, marks));
    }

    /** A player, or a page inside this one, as a link to what it shows. */
    private player(element: Element, flow: Flow, context: Context): void {
        const source =
            element.getAttribute('src') ??
            element.getAttribute('data') ??
            element.querySelector('source[src]')?.getAttribute('src') ??
            '';
        const address = this.address(source.trim());
        if (!address || !/^https?:/i.test(address)) {
            this.leftOut++;
            return;
        }
        const label = oneLine(element.getAttribute('title') ?? '') || address;
        const linked = withLink(context, address, null, this.schema);
        flow.text(label, this.marksOf(linked));
    }

    /** A formula, as the TeX it was written in when the page carries it. */
    private math(element: Element, flow: Flow, context: Context): void {
        const tex = element.querySelector('annotation[encoding="application/x-tex"]');
        const words = oneLine((tex ?? element).textContent ?? '');
        flow.text(words, this.marksOf({ ...context, code: tex !== null || context.code }));
    }

    private codeBlock(element: Element): ProseMirrorNode[] {
        const { schema } = this;
        const content = codeText(element)
            .replace(/\u00a0/g, ' ')
            .replace(/\n$/, '');
        if (!content.trim()) return [];
        const language = codeLanguage(element);
        return [schema.nodes.codeBlock.create({ language }, schema.text(content))];
    }

    // --- lists --------------------------------------------------------------

    private list(element: Element, context: Context): ProseMirrorNode[] {
        const inside = styled(element, context, this.schema);
        const items: ListItem[] = [];
        for (const child of element.childNodes) {
            if (child.nodeType === ELEMENT) {
                const item = child as Element;
                if (NOT_CONTENT.has(item.localName) || hidden(item)) continue;
                if (item.localName === 'li') {
                    items.push({
                        checked: taskState(item),
                        blocks: this.blocksIn(item, styled(item, inside, this.schema)),
                    });
                    continue;
                }
            } else if (child.nodeType !== TEXT) {
                continue;
            }
            // A list written straight inside a list, as many tools nest them,
            // belongs to the item above it. Anything else between items is
            // an item that was not marked as one.
            const flow = new Flow(this.schema);
            this.node(child, flow, inside);
            flow.endLine();
            if (flow.blocks.length === 0) continue;
            const above = items.at(-1);
            if (above && isList(child)) above.blocks.push(...flow.blocks);
            else items.push({ checked: null, blocks: flow.blocks });
        }
        const start = Number.parseInt(element.getAttribute('start') ?? '1', 10);
        const first = Number.isFinite(start) ? start : 1;
        return lists(this.schema, items, element.localName === 'ol' ? first : null);
    }

    // --- tables -------------------------------------------------------------

    private table(element: Element, flow: Flow, context: Context): void {
        const inside = styled(element, context, this.schema);
        for (const caption of childrenNamed(element, 'caption')) this.node(caption, flow, inside);

        const groups = rowGroups(element);
        const grid = isLayout(element) ? null : tableGrid(groups);
        if (!grid) {
            // A table that only arranges a page gives way to what is in it,
            // in the order it is read.
            for (const cell of groups.flat().flatMap(cellsOf)) this.node(cell, flow, inside);
            return;
        }

        const { nodes } = this.schema;
        const rows = grid.map(({ cells, missing }) => {
            const built = cells.map(({ element: cell, colspan, rowspan, header }) => {
                const type = header ? nodes.tableHeader : nodes.tableCell;
                const content = this.blocksIn(cell, styled(cell, inside, this.schema));
                return type.create(
                    { colspan, rowspan, align: cellAlign(cell) },
                    nonEmpty(this.schema, content),
                );
            });
            for (let i = 0; i < missing; i++) built.push(nodes.tableCell.createAndFill()!);
            return nodes.tableRow.create(null, built);
        });
        flow.block(nodes.table.create(null, rows));
    }
}

/** The schemes a link in a note can have. The ones the editor itself keeps. */
const LINK_SCHEMES = new Set(['http', 'https', 'ftp', 'ftps', 'mailto', 'tel', 'sms']);

function withLink(context: Context, href: string, title: string | null, schema: Schema): Context {
    const link = schema.marks.link.create({ href, title });
    return { ...context, marks: [...without(context.marks, 'link'), link] };
}

function without(marks: readonly Mark[], name: string): readonly Mark[] {
    return marks.filter((mark) => mark.type.name !== name);
}

/** An element's own style, as a declaration to look in. */
function styleOf(element: Element): string {
    return (element.getAttribute('style') ?? '').toLowerCase();
}

function declared(style: string, property: string): string {
    for (const declaration of style.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon >= 0 && declaration.slice(0, colon).trim() === property) {
            return declaration.slice(colon + 1).trim();
        }
    }
    return '';
}

/**
 * The context inside an element: the marks around it, with those it gives.
 *
 * By its tag, and then by the style written on it, which is where some tools
 * write emphasis, and take it away again: a `<b>` whose weight is normal is
 * not bold.
 */
function styled(element: Element, context: Context, schema: Schema): Context {
    const name = element.localName;
    let marks = context.marks;
    const give = (mark: string) => {
        marks = [...without(marks, mark), schema.marks[mark].create()];
    };
    if (Object.hasOwn(MARKS, name)) give(MARKS[name]);

    const style = styleOf(element);
    if (style) {
        const weight = declared(style, 'font-weight');
        if (/^(bold|bolder|[6-9]00)\b/.test(weight)) give('bold');
        else if (/^(normal|lighter|[1-5]00)\b/.test(weight)) marks = without(marks, 'bold');

        const slant = declared(style, 'font-style');
        if (/^(italic|oblique)/.test(slant)) give('italic');
        else if (/^normal/.test(slant)) marks = without(marks, 'italic');

        const line = `${declared(style, 'text-decoration')} ${declared(style, 'text-decoration-line')}`;
        // A link is underlined already, and says so without the mark.
        const linked = marks.some((mark) => mark.type.name === 'link') || name === 'a';
        if (line.includes('underline') && !linked) give('underline');
        if (line.includes('line-through')) give('strike');
    }
    const code = context.code || CODE.has(name);
    return marks === context.marks && code === context.code ? context : { marks, code };
}

function hidden(element: Element): boolean {
    if (element.hasAttribute('hidden')) return true;
    if (element.localName === 'dialog' && !element.hasAttribute('open')) return true;
    // KaTeX writes a formula twice, once for reading and once to be looked at.
    if (element.getAttribute('class') === 'katex-html') return true;
    const style = styleOf(element);
    if (!style) return false;
    return declared(style, 'display').startsWith('none');
}

/** Whether a drawing is an icon beside words rather than something to see. */
function decorative(element: Element): boolean {
    if (element.getAttribute('aria-hidden') === 'true') return true;
    if (/^(presentation|none)$/.test(element.getAttribute('role') ?? '')) return true;
    if (element.closest('a, button')) return true;
    const side = (name: string) => Number.parseInt(element.getAttribute(name) ?? '', 10);
    return side('width') <= 32 || side('height') <= 32;
}

/**
 * Where an image's picture is. A page that loads its pictures as they are
 * scrolled to keeps the address somewhere else until then, with a blank one
 * in its place.
 */
function imageSource(element: Element): string {
    const src = element.getAttribute('src')?.trim() ?? '';
    const later = element.getAttribute('data-src')?.trim() ?? '';
    if (later && (!src || src.startsWith('data:'))) return later;
    if (src) return src;
    const set = element.getAttribute('srcset')?.trim() ?? '';
    return set.split(/[\s,]/)[0];
}

function codeText(node: Node): string {
    let out = '';
    for (const child of node.childNodes) {
        if (child.nodeType === TEXT) out += child.nodeValue ?? '';
        else if (child.nodeType !== ELEMENT) continue;
        else if ((child as Element).localName === 'br') out += '\n';
        else if (!NOT_CONTENT.has((child as Element).localName)) out += codeText(child);
    }
    return out;
}

/** The language a highlighter was told, wherever it was told it. */
function codeLanguage(pre: Element): string | null {
    const code = pre.querySelector('code');
    for (const element of [code, pre, pre.parentElement]) {
        const match = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(
            element?.getAttribute('class') ?? '',
        );
        if (match) return match[1];
    }
    return null;
}

function isList(node: Node): boolean {
    return (
        node.nodeType === ELEMENT &&
        ['ul', 'ol', 'menu', 'dir'].includes((node as Element).localName)
    );
}

/**
 * Whether a list item is a task, and whether it is ticked: one that begins
 * with a checkbox, or that says so as the editor's own HTML does.
 */
function taskState(item: Element): boolean | null {
    const said = item.getAttribute('data-checked');
    if (said !== null) return said !== 'false';
    const box = leadingCheckbox(item);
    return box ? box.hasAttribute('checked') : null;
}

/** The checkbox an element begins with, inside a label or a paragraph or not. */
function leadingCheckbox(element: Element): Element | null {
    for (const child of element.childNodes) {
        if (child.nodeType === TEXT && !(child.nodeValue ?? '').trim()) continue;
        if (child.nodeType === TEXT) return null;
        if (child.nodeType !== ELEMENT) continue;
        const inner = child as Element;
        if (inner.localName === 'input') {
            return inner.getAttribute('type')?.toLowerCase() === 'checkbox' ? inner : null;
        }
        return ['div', 'label', 'p', 'span'].includes(inner.localName)
            ? leadingCheckbox(inner)
            : null;
    }
    return null;
}

// --- tables -------------------------------------------------------------------

function childrenNamed(element: Element, ...names: string[]): Element[] {
    return [...element.children].filter((child) => names.includes(child.localName));
}

/** A table's rows by the group they are in, with the footer last. */
function rowGroups(table: Element): Element[][] {
    const groups: { rows: Element[]; last: boolean }[] = [];
    for (const child of table.children) {
        if (child.localName === 'tr') groups.push({ rows: [child], last: false });
        else if (['thead', 'tbody', 'tfoot'].includes(child.localName) && !hidden(child)) {
            const rows = childrenNamed(child, 'tr');
            groups.push({ rows, last: child.localName === 'tfoot' });
        }
    }
    return [...groups.filter(({ last }) => !last), ...groups.filter(({ last }) => last)].map(
        ({ rows }) => rows.filter((row) => !hidden(row)),
    );
}

function cellsOf(row: Element): Element[] {
    return childrenNamed(row, 'td', 'th').filter((cell) => !hidden(cell));
}

/**
 * Whether a table is there to arrange a page rather than to be read as one:
 * it says so, it has a table inside it, or it has a single cell.
 */
function isLayout(table: Element): boolean {
    if (/^(presentation|none)$/.test(table.getAttribute('role') ?? '')) return true;
    if (table.querySelector('table')) return true;
    return table.querySelectorAll('td, th').length < 2;
}

interface GridCell {
    element: Element;
    colspan: number;
    rowspan: number;
    header: boolean;
}

interface GridRow {
    cells: GridCell[];
    /** How many cells it is short of the widest row. */
    missing: number;
}

/**
 * A table's cells, with every row as wide as the widest.
 *
 * HTML lets a row stop short, a cell reach past the last row, and two cells
 * claim the same place. The editor's tables are full grids, and repair
 * themselves when opened if they are not, which would be a change to the note
 * nobody made. Null for a table with no cells, or too many.
 */
function tableGrid(groups: Element[][]): GridRow[] | null {
    const rows: { cells: GridCell[]; width: number; covered: number }[] = [];
    for (const group of groups) {
        // How many more rows the cell above each column reaches down.
        let reach: number[] = [];
        for (const [index, row] of group.entries()) {
            const cells: GridCell[] = [];
            const below = reach.map((count) => Math.max(count - 1, 0));
            const taken = (at: number) => (reach[at] ?? 0) > 0;
            let column = 0;
            for (const element of cellsOf(row)) {
                while (taken(column)) column++;
                const wanted = span(element, 'colspan');
                let colspan = 1;
                while (colspan < wanted && !taken(column + colspan)) colspan++;
                // No further than the group, as a browser draws it.
                const rowspan = Math.min(span(element, 'rowspan'), group.length - index);
                for (let i = 0; i < colspan; i++) below[column + i] = rowspan - 1;
                column += colspan;
                if (column > MAX_CELLS) return null;
                const header =
                    element.localName === 'th' || row.parentElement?.localName === 'thead';
                cells.push({ element, colspan, rowspan, header });
            }
            const spanned = reach.filter((count) => count > 0).length;
            const own = cells.reduce((sum, { colspan }) => sum + colspan, 0);
            const width = Math.max(column, reach.findLastIndex((count) => count > 0) + 1);
            rows.push({ cells, width, covered: spanned + own });
            reach = Array.from(below, (count) => count ?? 0);
        }
    }
    const width = Math.max(0, ...rows.map((row) => row.width));
    if (width === 0 || width * rows.length > MAX_CELLS) return null;
    return rows.map(({ cells, covered }) => ({ cells, missing: width - covered }));
}

function span(cell: Element, name: 'colspan' | 'rowspan'): number {
    const value = Number.parseInt(cell.getAttribute(name) ?? '1', 10);
    // Down to the end of the group, which is as far as any cell goes.
    if (value === 0 && name === 'rowspan') return Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(value) || value < 1) return 1;
    return name === 'colspan' ? Math.min(value, MAX_COLSPAN) : value;
}

function cellAlign(cell: Element): 'left' | 'center' | 'right' | null {
    const value =
        declared(styleOf(cell), 'text-align') || (cell.getAttribute('align') ?? '').toLowerCase();
    return value === 'left' || value === 'center' || value === 'right' ? value : null;
}
