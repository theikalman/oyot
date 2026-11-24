import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { contentSchema } from '$lib/editor/headlessIndex';
import { isWholePage } from '$lib/editor/htmlPreview/blocks';
import { storeEmbedded, type SaveImage } from '$lib/import/embeddedImages';
import { parseHtml } from '$lib/import/html';
import { isEmpty, noteDocument } from '$lib/import/note';
import { noteLinkOf, type NoteContext } from './noteMarkdown';

/**
 * An HTML page an assistant sent, as the blocks of a note (ADR 0045).
 *
 * Built before any note is made, so a page that cannot be one leaves nothing
 * behind.
 */

/** A note that shows the page, or one that says what the page says. */
export type HtmlMode = 'page' | 'editable';

/** What a page has that will not be seen, for the assistant to be told. */
export interface HtmlLosses {
    /** It has scripts, which do not run. */
    scripts: boolean;
    /** It names files outside itself, which are not loaded. */
    outside: boolean;
    /** Images kept as their Markdown, because there was nothing to show. */
    imagesKeptAsText: number;
    /** Drawings, players and pictures that had to be left out. */
    leftOut: number;
}

export interface HtmlNote {
    blocks: ProseMirrorNode[];
    losses: HtmlLosses;
}

export async function htmlNote(
    title: string,
    html: string,
    mode: HtmlMode,
    ctx: NoteContext,
    save: SaveImage,
): Promise<HtmlNote> {
    return mode === 'page' ? pageNote(html) : editableNote(title, html, ctx, save);
}

/**
 * The page as it is, in a code block the viewer shows (ADR 0043). One without
 * a doctype is given one, as that is how the viewer knows a page from a piece
 * of one, and what an assistant writes often leaves it to whoever serves it.
 */
function pageNote(html: string): HtmlNote {
    const schema = contentSchema();
    const source = html
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();
    const page = isWholePage(source) ? source : `<!doctype html>\n${source}`;
    const block = schema.nodes.codeBlock.create({ language: 'html' }, schema.text(page));
    return {
        blocks: [block],
        losses: { ...unseen(source), imagesKeptAsText: 0, leftOut: 0 },
    };
}

/** What the page says, read as an imported file is (ADR 0042). */
async function editableNote(
    title: string,
    html: string,
    ctx: NoteContext,
    save: SaveImage,
): Promise<HtmlNote> {
    const read = noteDocument(
        { name: '', format: 'html', title, body: html, tags: [] },
        contentSchema(),
        { noteLink: noteLinkOf(ctx) },
    );
    if (isEmpty(read.doc)) {
        throw new Error(
            'The page has no words or pictures of its own to keep, so no note was made. One built ' +
                'by its scripts has to be sent as the HTML they make.',
        );
    }
    const { doc, failed } = await storeEmbedded(read.doc, save);
    return {
        blocks: [...doc.children],
        losses: {
            scripts: false,
            outside: false,
            imagesKeptAsText: read.imagesKeptAsText,
            leftOut: read.leftOut + failed,
        },
    };
}

/** Attributes that name a file the page would load. */
const LOADS = ['src', 'srcset', 'poster', 'data'];

/** What the viewer will not run or load. Best effort: it is only a warning. */
function unseen(source: string): { scripts: boolean; outside: boolean } {
    let scripts = false;
    let outside = false;
    let css = '';
    for (const element of parseHtml(source).querySelectorAll('*')) {
        const name = element.localName;
        if (name === 'script') {
            scripts ||= runs(element.getAttribute('type'));
            continue;
        }
        if (name === 'style') css += `${element.textContent}\n`;
        if (name === 'link' && /\bstylesheet\b/i.test(element.getAttribute('rel') ?? '')) {
            outside = true;
        }
        for (const { name: attribute, value } of element.attributes) {
            if (/^on[a-z]/i.test(attribute)) scripts = true;
            if (attribute === 'style') css += `${value}\n`;
            if (LOADS.includes(attribute) && !isInside(value)) outside = true;
        }
    }
    return { scripts, outside: outside || loadsFromCss(css) };
}

/** Whether a script of this type is one a browser would run, rather than data. */
function runs(type: string | null): boolean {
    return !type?.trim() || /^(module|(text|application)\/(java|ecma)script)\b/i.test(type.trim());
}

function loadsFromCss(css: string): boolean {
    if (/@import\b/i.test(css)) return true;
    for (const [, address] of css.matchAll(/\burl\(\s*["']?([^"')\s]{0,16})/gi)) {
        if (!isInside(address)) return true;
    }
    return false;
}

/** Whether an address is inside the page: a picture in its text, or a part of it. */
function isInside(address: string): boolean {
    return /^\s*(data:image\/|#|$)/i.test(address);
}
