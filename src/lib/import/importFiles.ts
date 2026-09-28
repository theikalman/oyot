import * as Y from 'yjs';
import { prosemirrorToYDoc } from '@tiptap/y-tiptap';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { CONTENT_FIELD } from '$lib/editor/contentField';
import type { DocumentIndex } from '$lib/editor/documentIndex';
import { contentSchema, indexFromYDoc } from '$lib/editor/headlessIndex';
import type { NoteLinkTarget } from './markdown';
import { isEmpty, noteDocument, prepareNote, type MarkdownFile, type PreparedNote } from './note';

/**
 * Turning picked files into notes: all of an import but the IPC.
 *
 * Every file becomes an empty note first and is filled in after, because a
 * link from one file to another in the same import can only become a link to
 * that note once the note has an id. Each file's content is then built
 * against the editor's schema, made into the CRDT the editor would have made
 * from it, and saved through the calls an edit in the editor takes, so it is
 * indexed, counted and sent to paired devices the same way.
 *
 * The writes go through an interface rather than Tauri, as a backup import's
 * do, so this is testable without the app. See
 * docs/decisions/0029-import-markdown-files-as-notes.md.
 */

/** What an import writes through: `documentActions` and the repository. */
export interface ImportTarget {
    /** Make an empty, unpinned note. */
    createNote(title: string): Promise<NoteLinkTarget>;
    /** Store a note's content as the editor's save does, and send it on. */
    saveContent(docId: string, state: Uint8Array, index: DocumentIndex): Promise<void>;
    /** Take back a note that could not be filled in. */
    deleteNote(docId: string): Promise<void>;
    /** Which of these attachments this device holds. */
    heldAttachments(hashes: string[]): Promise<Set<string>>;
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

/**
 * Make a note of each file.
 *
 * A file that cannot be made into one is named in the result and the rest go
 * on: one bad file out of forty is not a reason to import none. A note whose
 * content could not be saved is deleted again rather than left empty under a
 * title that suggests otherwise.
 */
export async function importFiles(
    files: MarkdownFile[],
    target: ImportTarget,
    onProgress: (done: number, total: number) => void = () => {},
): Promise<ImportResult> {
    const skipped: SkippedFile[] = [];
    const schema = contentSchema();

    // In the order of their names, as a folder lists them. The Notes page
    // lists the newest first, so the notes are made last to first and the
    // first file's note is the newest.
    const ordered = [...files].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );

    const prepared: PreparedNote[] = [];
    for (const file of ordered) {
        try {
            prepared.push(prepareNote(file));
        } catch (e) {
            console.warn(`[import] could not read ${file.name}:`, e);
            skipped.push({ name: file.name, reason: 'failed' });
        }
    }

    const created = new Map<PreparedNote, NoteLinkTarget>();
    for (const note of [...prepared].reverse()) {
        try {
            created.set(note, await target.createNote(note.title));
        } catch (e) {
            console.warn(`[import] could not create a note for ${note.name}:`, e);
            skipped.push({ name: note.name, reason: 'failed' });
        }
    }

    const noteLink = linksBetween(prepared, created);
    const notes: NoteLinkTarget[] = [];
    const attachments = new Set<string>();
    let imagesKeptAsText = 0;
    const total = created.size;
    let done = 0;
    onProgress(done, total);

    for (const note of prepared) {
        const made = created.get(note);
        if (!made) continue;
        try {
            const read = noteDocument(note, schema, { noteLink });
            if (!isEmpty(read.doc)) {
                const index = await save(made.id, read.doc, target);
                for (const hash of index.attachmentHashes) attachments.add(hash);
            }
            imagesKeptAsText += read.imagesKeptAsText;
            notes.push(made);
        } catch (e) {
            console.warn(`[import] could not fill in ${note.name}:`, e);
            skipped.push({ name: note.name, reason: 'failed' });
            await target.deleteNote(made.id).catch((error) => {
                console.warn(`[import] could not take back ${made.id}:`, error);
            });
        }
        onProgress(++done, total);
    }

    return {
        notes,
        skipped,
        imagesKeptAsText,
        missingImages: await countMissing([...attachments], target),
    };
}

/**
 * Save a document as the content of the note `docId`, and return its index.
 *
 * The CRDT is made from the document the way y-tiptap documents doing it for
 * content that has never been in an editor. The index is read back out of
 * the CRDT rather than the document it was made from, so it describes what
 * was stored.
 */
async function save(
    docId: string,
    doc: ProseMirrorNode,
    target: ImportTarget,
): Promise<DocumentIndex> {
    const ydoc = prosemirrorToYDoc(doc, CONTENT_FIELD);
    try {
        const index = indexFromYDoc(ydoc);
        await target.saveContent(docId, Y.encodeStateAsUpdate(ydoc), index);
        return index;
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
 * than to whichever came first.
 */
function linksBetween(
    prepared: PreparedNote[],
    created: Map<PreparedNote, NoteLinkTarget>,
): (href: string) => NoteLinkTarget | null {
    const byName = new Map<string, NoteLinkTarget | null>();
    for (const note of prepared) {
        const made = created.get(note);
        if (!made || !note.name) continue;
        const key = nameKey(note.name);
        byName.set(key, byName.has(key) ? null : made);
    }
    return (href) => {
        const name = linkedFileName(href);
        return name ? (byName.get(nameKey(name)) ?? null) : null;
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
