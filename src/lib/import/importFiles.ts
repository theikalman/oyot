import * as Y from 'yjs';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import { extractDocumentIndex, type DocumentIndex } from '$lib/editor/documentIndex';
import { contentSchema } from '$lib/editor/headlessIndex';
import type { NoteLinkTarget } from './markdown';
import { isEmpty, noteDocument, prepareNote, type MarkdownFile, type PreparedNote } from './note';

/**
 * Turning picked files into notes: all of an import but the IPC.
 *
 * Each note's id is chosen before any note is made, so a link from one file to
 * another can be written as a link to that note however the two are ordered.
 * Then each file in turn is read against the editor's schema, made into the
 * CRDT the editor would have made from it, and written whole: the note, then
 * its content, merged into whatever the note holds as a peer's edit would be.
 * An import cut short by the app closing leaves at most the one note it was
 * writing without its content.
 *
 * Finished notes are listed and announced to paired devices in batches, with
 * one refresh of the views that read derived rows per batch, rather than one
 * per note, which on a large import redraws every list thousands of times.
 *
 * The writes go through an interface rather than Tauri, as a backup import's
 * do, so this is testable without the app. See
 * docs/decisions/0029-import-markdown-files-as-notes.md.
 */

/** What an import writes through: `documentActions` and the repository. */
export interface ImportTarget {
    /** Make a note, unpinned, under `id`. Nothing is told of it yet. */
    createNote(id: string, title: string): Promise<void>;
    /**
     * Merge content into a note, as a peer's edit is merged. Returns what was
     * indexed from the merged note, or null if it could not be indexed.
     */
    saveContent(id: string, update: Uint8Array): Promise<DocumentIndex | null>;
    /** List finished notes and tell paired devices of them. */
    publish(notes: PublishedNote[]): void;
    /** Take back a note whose content could not be saved. */
    deleteNote(id: string): Promise<void>;
    /** Which of these attachments this device holds. */
    heldAttachments(hashes: string[]): Promise<Set<string>>;
}

export interface PublishedNote {
    id: string;
    hasContent: boolean;
    index: DocumentIndex | null;
}

/** Why a file did not become a note. The first three are Rust's. */
export type SkipReason = 'unreadable' | 'too-large' | 'not-text' | 'failed';

export interface SkippedFile {
    /** What the file was called. Empty when that is not known. */
    name: string;
    reason: SkipReason;
}

export interface ImportResult {
    /** The notes made, in the order of their files' names. */
    notes: NoteLinkTarget[];
    /** Files that did not become notes. */
    skipped: SkippedFile[];
    /** Images kept as their Markdown, because there was nothing to show. */
    imagesKeptAsText: number;
    /**
     * Images the notes name by attachment that this device does not hold.
     * They show once a paired device that holds them has sent them over.
     */
    missingImages: number;
}

/** How many finished notes are listed and announced at a time. */
const PUBLISH_EVERY = 25;

/**
 * Make a note of each file.
 *
 * Each note's text is let go of once the note is written, since an import
 * can be most of a library at once. The files themselves are the caller's,
 * and left as they are.
 *
 * A file that cannot be made into a note is named in the result and the rest
 * go on: one bad file out of forty is not a reason to import none. A note
 * whose content could not be saved is deleted again rather than left empty
 * under a title that suggests otherwise, and later files' links to it stay
 * links.
 */
export async function importFiles(
    files: MarkdownFile[],
    target: ImportTarget,
    onProgress: (done: number, total: number) => void = () => {},
    newId: () => string = () => crypto.randomUUID(),
): Promise<ImportResult> {
    const skipped: SkippedFile[] = [];
    const schema = contentSchema();

    // In the order of their names, as a folder lists them.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const ordered = [...files].sort((a, b) => collator.compare(a.name, b.name));

    const prepared: { note: PreparedNote; id: string }[] = [];
    for (const file of ordered) {
        try {
            prepared.push({ note: prepareNote(file), id: newId() });
        } catch (e) {
            console.warn(`[import] could not read ${file.name}:`, e);
            skipped.push({ name: file.name, reason: 'failed' });
        }
    }

    const links = linksBetween(prepared);
    const made: NoteLinkTarget[] = [];
    const batch: PublishedNote[] = [];
    const attachments = new Set<string>();
    let imagesKeptAsText = 0;
    let done = 0;
    onProgress(done, prepared.length);

    // Made last to first, so the first file's note is the newest and the
    // Notes page, newest first, lists them in the order of their names.
    for (const { note, id } of [...prepared].reverse()) {
        try {
            // Read before anything is written: a file that cannot be read
            // makes no note at all.
            const read = noteDocument(note, schema, { noteLink: links.find });
            await target.createNote(id, note.title);
            let index: DocumentIndex | null = null;
            const hasContent = !isEmpty(read.doc);
            if (hasContent) {
                try {
                    index = await target.saveContent(id, stateOf(read.doc));
                } catch (e) {
                    await target.deleteNote(id).catch((error) => {
                        console.warn(`[import] could not take back ${id}:`, error);
                    });
                    throw e;
                }
                const named = index ?? extractDocumentIndex(read.doc);
                for (const hash of named.attachmentHashes) attachments.add(hash);
            }
            imagesKeptAsText += read.imagesKeptAsText;
            made.push({ id, title: note.title });
            batch.push({ id, hasContent, index });
            if (batch.length >= PUBLISH_EVERY) target.publish(batch.splice(0));
        } catch (e) {
            console.warn(`[import] could not import ${note.name}:`, e);
            skipped.push({ name: note.name, reason: 'failed' });
            links.forget(note);
        }
        note.body = '';
        onProgress(++done, prepared.length);
    }
    if (batch.length > 0) target.publish(batch.splice(0));

    return {
        notes: made.reverse(),
        skipped,
        imagesKeptAsText,
        missingImages: await countMissing([...attachments], target),
    };
}

/**
 * A document as the CRDT update that holds it, made the way y-tiptap
 * documents doing it for content that has never been in an editor.
 */
function stateOf(doc: ProseMirrorNode): Uint8Array {
    const ydoc = prosemirrorToYDoc(doc, CONTENT_FIELD);
    try {
        return Y.encodeStateAsUpdate(ydoc);
    } finally {
        ydoc.destroy();
    }
}

/**
 * How a link in one file finds the note another file became.
 *
 * By the file's name, which is what a relative link names: the exporter
 * writes a link to another note as its file, and other tools link the same
 * way. The folders in a link are not compared, since everything picked in one
 * dialog is side by side. A name two files share links to neither, rather
 * than to whichever came first. A file that failed is forgotten, so the files
 * after it keep their links to it as links.
 */
function linksBetween(prepared: { note: PreparedNote; id: string }[]) {
    const byName = new Map<string, NoteLinkTarget | null>();
    for (const { note, id } of prepared) {
        if (!note.name) continue;
        const key = nameKey(note.name);
        byName.set(key, byName.has(key) ? null : { id, title: note.title });
    }
    return {
        find(href: string): NoteLinkTarget | null {
            const name = linkedFileName(href);
            return name ? (byName.get(nameKey(name)) ?? null) : null;
        },
        forget(note: PreparedNote): void {
            if (note.name) byName.set(nameKey(note.name), null);
        },
    };
}

/** The file a relative link names, or null for a link that names none. */
export function linkedFileName(href: string): string | null {
    // A web address, `mailto:` and the like, or a link within the page.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
        return null;
    }
    const path = href.split(/[?#]/)[0];
    let decoded = path;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        // A stray `%` that is not an escape: the name is as written.
    }
    return decoded.split(/[\\/]/).pop() || null;
}

function nameKey(name: string): string {
    return name.normalize('NFC').toLowerCase();
}

async function countMissing(hashes: string[], target: ImportTarget): Promise<number> {
    if (hashes.length === 0) return 0;
    try {
        const held = await target.heldAttachments(hashes);
        return hashes.filter((hash) => !held.has(hash)).length;
    } catch (e) {
        // Only a warning depends on this, so a failure costs the warning.
        console.warn('[import] could not check which images are here:', e);
        return 0;
    }
}
