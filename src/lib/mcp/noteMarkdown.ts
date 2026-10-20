import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentSchema } from '$lib/editor/headlessIndex';
import { serializeBlocks, type MarkdownOptions } from '$lib/export/markdown';
import { readMarkdown, type MarkdownReadOptions } from '$lib/import/markdown';
import { attachmentHash } from '$lib/tiptap/attachmentRef';

/**
 * A note as an assistant reads and writes it, over MCP (ADR 0037).
 *
 * The archive's exporter and the importer do the work, set up for a reader
 * that resolves Oyot's own addresses rather than files beside the note:
 *
 * - a link to another note is `oyot://note/<id>`, and its words are read back
 *   as the title its chip held
 * - an attachment is `oyot-attachment://<hash>`, the address the editor stores
 * - an image held inline as a `data:` URI, which notes written before
 *   attachments were content-addressed still have, is
 *   `oyot-inline-image://<n>`, so a read does not hand an assistant a page of
 *   base64, and is mapped back to the URI on the way in
 *
 * Pure, like the converters, and for the same reason: it has to be testable
 * without Tauri, the sync layer or a DOM.
 */

export const NOTE_LINK_SCHEME = 'oyot://note/';
export const INLINE_IMAGE_SCHEME = 'oyot-inline-image://';

/** What a note's addresses resolve against. */
export interface NoteContext {
    /** A note's current title by id, or null when there is no such note. */
    noteTitle: (id: string) => string | null;
    /** Every tag name any note carries, normalized, so `#house move` reads whole. */
    knownTags: readonly string[];
}

/** An image in a note, in document order. */
export interface NoteImage {
    /** An attachment's content hash, or an inline image's `oyot-inline-image://` id. */
    ref: string;
    kind: 'attachment' | 'inline';
    /** The image's description, or null when it has none. */
    alt: string | null;
}

/** A note rendered for reading, and what is needed to read a rewrite of it back. */
export interface RenderedNote {
    markdown: string;
    /** Each top-level block's Markdown, one entry per block; an empty paragraph is ''. */
    blocks: string[];
    /** Inline images by id, the `data:` URI each stands for. */
    inlineImages: ReadonlyMap<string, string>;
    images: NoteImage[];
}

const ATTACHMENT_ALT = /^oyot:/;

/** Render a note as the Markdown an assistant reads. */
export function renderNote(root: ProseMirrorNode): RenderedNote {
    const inlineImages = new Map<string, string>();
    const images: NoteImage[] = [];

    // Inline images get an address of their own first, so the exporter writes
    // that rather than the URI. Numbered in document order: the same document
    // always gets the same numbers, which is all a rewrite of it needs. The
    // same image twice is one number, so a block holding either renders the
    // same however it is read back.
    const ids = new Map<string, string>();
    const tokenized = mapImages(root, (node) => {
        const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
        const alt = describedAlt(node.attrs.alt);
        if (src.startsWith('data:')) {
            let id = ids.get(src);
            if (!id) {
                id = String(ids.size + 1);
                ids.set(src, id);
                inlineImages.set(id, src);
            }
            images.push({ ref: id, kind: 'inline', alt });
            return { ...node.attrs, src: `${INLINE_IMAGE_SCHEME}${id}` };
        }
        const hash = attachmentHash(src, node.attrs.alt);
        if (hash) images.push({ ref: hash, kind: 'attachment', alt });
        return null;
    });

    const blocks = serializeBlocks(tokenized, writeOptions);
    const body = blocks.filter((block) => block.trim().length > 0).join('\n\n');
    return { markdown: body ? `${body}\n` : '', blocks, inlineImages, images };
}

/** Read an assistant's Markdown into a document, against what `renderNote` gave it. */
export function parseNote(
    markdown: string,
    ctx: NoteContext,
    inlineImages: ReadonlyMap<string, string> = new Map(),
): ProseMirrorNode {
    return readMarkdown(markdown, contentSchema(), readOptions(ctx, inlineImages)).doc;
}

/**
 * Render a block on its own, the way `renderNote` renders it. For a block
 * read back from an assistant's Markdown, so it can be compared with the
 * blocks the note already has.
 */
export function renderBlock(
    node: ProseMirrorNode,
    inlineImages: ReadonlyMap<string, string>,
): string {
    const doc = contentSchema().topNodeType.create(null, [node]);
    const byUri = new Map([...inlineImages].map(([id, uri]) => [uri, id]));
    const tokenized = mapImages(doc, (image) => {
        const src = typeof image.attrs.src === 'string' ? image.attrs.src : '';
        const id = byUri.get(src);
        return id ? { ...image.attrs, src: `${INLINE_IMAGE_SCHEME}${id}` } : null;
    });
    return serializeBlocks(tokenized, writeOptions)[0] ?? '';
}

/** The hex SHA-256 of a note's Markdown: the revision an edit has to name. */
export async function revisionOf(markdown: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(markdown));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const writeOptions: MarkdownOptions = {
    // Never a file: an attachment stays under the address the editor stores,
    // and the exporter writes that when there is no path.
    attachmentPath: () => null,
    missingAttachmentAlt: '',
    notePath: (id) => `${NOTE_LINK_SCHEME}${id}`,
};

function readOptions(
    ctx: NoteContext,
    inlineImages: ReadonlyMap<string, string>,
): MarkdownReadOptions {
    return {
        knownTags: ctx.knownTags,
        noteLink: (href) => {
            if (!href.startsWith(NOTE_LINK_SCHEME)) return null;
            const id = href.slice(NOTE_LINK_SCHEME.length);
            const title = ctx.noteTitle(id);
            return title === null ? null : { id, title };
        },
        noteLinkLabelIsTitle: true,
        imageSource: (src) => {
            if (!src.startsWith(INLINE_IMAGE_SCHEME)) return src;
            return inlineImages.get(src.slice(INLINE_IMAGE_SCHEME.length)) ?? src;
        },
    };
}

/** An image's description, without the bookkeeping the editor keeps in it. */
function describedAlt(alt: unknown): string | null {
    return typeof alt === 'string' && alt && !ATTACHMENT_ALT.test(alt) ? alt : null;
}

/**
 * The document with every image's attributes replaced by what `change`
 * returns for it, or left alone where it returns null. Every image, at any
 * depth: one can sit in a list item, a quote or a table cell.
 */
function mapImages(
    node: ProseMirrorNode,
    change: (image: ProseMirrorNode) => Record<string, unknown> | null,
): ProseMirrorNode {
    if (node.type.name === 'image') {
        const attrs = change(node);
        return attrs ? node.type.create(attrs, null, node.marks) : node;
    }
    if (node.isLeaf || node.isTextblock) return node;
    let changed = false;
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => {
        const mapped = mapImages(child, change);
        if (mapped !== child) changed = true;
        children.push(mapped);
    });
    return changed ? node.copy(Fragment.from(children)) : node;
}
