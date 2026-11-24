import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';
import { nonEmpty } from './build';
import { splitFrontMatter, type FrontMatterValue } from './frontMatter';
import { htmlTitle, parseHtml, readHtml } from './html';
import { leadingHeading, oneLine, readMarkdown, type NoteLinkTarget } from './markdown';

/**
 * One file, as a note: what it is called, what it is tagged, and what it says.
 *
 * For Markdown, the other half of `$lib/export/note`, which writes a note as front matter,
 * the title again as a heading, and the body. Reading that back has to find
 * the title in either place and not keep it twice, and has to do something
 * sensible with the files other tools write, which put the title in the file
 * name, the front matter or a heading, and the tags in the front matter or in
 * the words.
 *
 * HTML says what it is called in its `<title>`, and usually again in a heading.
 */

/** What a file is written in, as Rust worked it out. */
export type NoteFormat = 'markdown' | 'html';

/** A file as `pick_note_files` hands it over. */
export interface NoteFile {
    /** What the file was called. Empty when that is not known. */
    name: string;
    text: string;
    format: NoteFormat;
}

export interface PreparedNote {
    /** The file it came from. */
    name: string;
    format: NoteFormat;
    title: string;
    /**
     * What the note says: for Markdown, the file without its front matter,
     * and without the heading that became its title; for HTML, all of it.
     */
    body: string;
    /** The tags its front matter lists, normalized. */
    tags: string[];
}

/** A note's content, and what in its file could not come in as it was. */
export interface NoteContent {
    doc: ProseMirrorNode;
    /** Images kept as their Markdown, because there was nothing to show. */
    imagesKeptAsText: number;
    /** Drawings, players and pictures that had to be left out. */
    leftOut: number;
}

export interface NoteReadOptions {
    /** The note a link in the file points at, when it is being imported too. */
    noteLink?: (href: string) => NoteLinkTarget | null;
}

/**
 * Work out a file's title and tags, and what is left to become its content.
 *
 * The title is the front matter's when it has one, otherwise a heading that
 * opens the file, otherwise the file's name. A heading at the top that gave
 * the title, or only says the front matter's title again (the exporter writes
 * both), comes out of the body: a note shows its title above its content, and
 * would otherwise open with its own name twice. A heading that says something
 * else is the note's own, and stays.
 *
 * A heading that became the title keeps its tags, which join the front
 * matter's at the top of the note, since the heading itself is gone. One that
 * only repeats the front matter's title gives none: that heading was written
 * from the title, which is plain words.
 */
export function prepareNote(file: NoteFile): PreparedNote {
    return file.format === 'html' ? prepareHtml(file) : prepareMarkdown(file);
}

function prepareHtml({ name, format, text }: NoteFile): PreparedNote {
    const title = htmlTitle(parseHtml(text)) || titleFromFileName(name) || 'Untitled';
    return { name, format, title, body: text, tags: [] };
}

function prepareMarkdown(file: NoteFile): PreparedNote {
    const { name, format } = file;
    const text = file.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const { values, body } = splitFrontMatter(text);
    const given = oneLine(stringOf(valueOf(values, 'title')) ?? '');
    const tags = tagsOf(valueOf(values, 'tags') ?? valueOf(values, 'tag'));

    const heading = leadingHeading(body, tags);
    if (heading?.text && !given) {
        return {
            name,
            format,
            title: heading.text,
            body: withoutLines(body, heading.lines),
            tags: [...new Set([...tags, ...heading.tags])],
        };
    }
    // Compared as read and as written: an older export wrote the title into
    // its heading unescaped, so `Plan *draft*` came back as emphasis.
    if (heading && (sameTitle(heading.text, given) || sameTitle(heading.source, given))) {
        return { name, format, title: given, body: withoutLines(body, heading.lines), tags };
    }
    return {
        name,
        format,
        title: given || titleFromFileName(name) || 'Untitled',
        body,
        tags,
    };
}

/** A prepared note's content, as a document. */
export function noteDocument(
    note: PreparedNote,
    schema: Schema,
    options: NoteReadOptions = {},
): NoteContent {
    return note.format === 'html'
        ? htmlDocument(note, schema, options)
        : markdownDocument(note, schema, options);
}

/**
 * The heading at the top of a page goes when it only says the note's title,
 * as it does from a Markdown file. A page has no tags to bring: a `#word` in
 * one is as likely a colour or a link to a part of it.
 */
function htmlDocument(note: PreparedNote, schema: Schema, options: NoteReadOptions): NoteContent {
    const read = readHtml(parseHtml(note.body), schema, options);
    const first = read.doc.firstChild;
    const titled =
        first?.type.name === 'heading' &&
        first.attrs.level === 1 &&
        sameTitle(first.textBetween(0, first.content.size, ' ', ' '), note.title);
    if (!titled) return read;
    const rest: ProseMirrorNode[] = [];
    read.doc.forEach((block, _, index) => {
        if (index > 0) rest.push(block);
    });
    return { ...read, doc: read.doc.type.create(read.doc.attrs, nonEmpty(schema, rest)) };
}

/**
 * The front matter's tags that the words do not already carry go at the top,
 * as a line of chips. A tag in Oyot is a chip in the text, and there is no
 * list beside a note to put the others in. The exporter lists only the tags a
 * note's words carry, so for a note that came from Oyot this adds nothing;
 * Obsidian and others keep tags in the front matter alone, and those would
 * otherwise be lost.
 */
function markdownDocument(
    note: PreparedNote,
    schema: Schema,
    options: NoteReadOptions,
): NoteContent {
    const read = readMarkdown(note.body, schema, { ...options, knownTags: note.tags });
    return { ...read, doc: withTags(read.doc, note.tags, schema), leftOut: 0 };
}

/** The extensions a note's file is saved under, which its title leaves off. */
const NOTE_EXTENSION = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtext|mdtxt|txt|html?|xhtml|xht)$/i;

/** A file's name as a title: without its folder and its extension. */
export function titleFromFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    return oneLine(base.replace(NOTE_EXTENSION, ''));
}

function withTags(doc: ProseMirrorNode, tags: string[], schema: Schema): ProseMirrorNode {
    // Read the way the indexer reads them, which is also how the exporter
    // decided which tags to list: the three cannot disagree about a chip.
    const carried = new Set(extractDocumentIndex(doc).tags);
    const missing = tags.filter((name) => !carried.has(name));
    if (missing.length === 0) return doc;

    const chips: ProseMirrorNode[] = [];
    for (const name of missing) {
        if (chips.length > 0) chips.push(schema.text(' '));
        chips.push(schema.nodes[TAG_NODE_NAME].create({ name }));
    }
    const line = schema.nodes.paragraph.create(null, chips);

    // A note with nothing else in it is the line of tags, rather than the
    // line and an empty paragraph under it.
    const blocks: ProseMirrorNode[] = [line];
    if (!isEmpty(doc)) doc.forEach((block) => blocks.push(block));
    return doc.type.create(doc.attrs, blocks);
}

/** The document the editor starts a note with: one empty paragraph. */
export function isEmpty(doc: ProseMirrorNode): boolean {
    const only = doc.firstChild;
    return doc.childCount === 1 && only?.type.name === 'paragraph' && only.childCount === 0;
}

/** A key's value, whatever case the key was written in. */
function valueOf(values: Map<string, FrontMatterValue>, key: string): FrontMatterValue {
    for (const [name, value] of values) {
        if (name.toLowerCase() === key) return value;
    }
    return null;
}

function stringOf(value: FrontMatterValue): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * The tags a front matter value lists: a list, or one string of names
 * separated by commas, or by spaces when there are no commas, which is how
 * Jekyll writes them. A leading `#` is dropped, as it is from any tag.
 */
function tagsOf(value: FrontMatterValue): string[] {
    if (value === null) return [];
    const names = Array.isArray(value)
        ? value
        : value.includes(',')
          ? value.split(',')
          : value.split(/\s+/);
    const tags = names.map(normalizeTagName).filter((name) => name.length > 0);
    return [...new Set(tags)];
}

function sameTitle(a: string, b: string): boolean {
    return oneLine(a).toLocaleLowerCase() === oneLine(b).toLocaleLowerCase();
}

function withoutLines(text: string, [from, to]: [number, number]): string {
    const lines = text.split('\n');
    lines.splice(from, to - from);
    return lines.join('\n');
}
