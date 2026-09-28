import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { normalizeTagName, TAG_NODE_NAME } from '$lib/tiptap/tags';
import { splitFrontMatter, type FrontMatterValue } from './frontMatter';
import {
    leadingHeading,
    readMarkdown,
    type MarkdownDocument,
    type MarkdownReadOptions,
} from './markdown';

/**
 * One Markdown file, as a note: what it is called, what it is tagged, and
 * what it says.
 *
 * The other half of `$lib/export/note`, which writes a note as front matter,
 * the title again as a heading, and the body. Reading that back has to find
 * the title in either place and not keep it twice, and has to do something
 * sensible with the files other tools write, which put the title in the file
 * name, the front matter or a heading, and the tags in the front matter or in
 * the words.
 */

/** A file as `pick_markdown_files` hands it over. */
export interface MarkdownFile {
    /** What the file was called. Empty when that is not known. */
    name: string;
    text: string;
}

export interface PreparedNote {
    /** The file it came from. */
    name: string;
    title: string;
    /**
     * What the note says: the file without its front matter, and without the
     * heading that became its title.
     */
    body: string;
    /** The tags its front matter lists, normalized. */
    tags: string[];
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
 */
export function prepareNote(file: MarkdownFile): PreparedNote {
    const text = file.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const { values, body } = splitFrontMatter(text);
    const given = oneLine(stringOf(valueOf(values, 'title')) ?? '');
    const tags = tagsOf(valueOf(values, 'tags') ?? valueOf(values, 'tag'));

    const heading = leadingHeading(body, tags);
    if (heading?.text && (!given || sameTitle(heading.text, given))) {
        return {
            name: file.name,
            title: given || heading.text,
            body: withoutLines(body, heading.lines),
            tags,
        };
    }
    return {
        name: file.name,
        title: given || titleFromFileName(file.name) || 'Untitled',
        body,
        tags,
    };
}

/**
 * A prepared note's content, as a document.
 *
 * The front matter's tags that the words do not already carry go at the top,
 * as a line of chips. A tag in Oyot is a chip in the text, and there is no
 * list beside a note to put the others in. The exporter lists only the tags a
 * note's words carry, so for a note that came from Oyot this adds nothing;
 * Obsidian and others keep tags in the front matter alone, and those would
 * otherwise be lost.
 */
export function noteDocument(
    note: PreparedNote,
    schema: Schema,
    options: Omit<MarkdownReadOptions, 'knownTags'> = {},
): MarkdownDocument {
    const read = readMarkdown(note.body, schema, { ...options, knownTags: note.tags });
    return { ...read, doc: withTags(read.doc, note.tags, schema) };
}

/** The extensions a note's file is saved under, which its title leaves off. */
const NOTE_EXTENSION = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtext|mdtxt|txt)$/i;

/** A file's name as a title: without its folder and its extension. */
export function titleFromFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? '';
    return oneLine(base.replace(NOTE_EXTENSION, ''));
}

function withTags(doc: ProseMirrorNode, tags: string[], schema: Schema): ProseMirrorNode {
    const carried = new Set<string>();
    doc.descendants((node) => {
        if (node.type.name === TAG_NODE_NAME) carried.add(String(node.attrs.name ?? ''));
    });
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

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}
