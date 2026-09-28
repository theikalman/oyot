import { invoke } from '@tauri-apps/api/core';
import { appStore } from '$lib/stores/app';
import { createNote, deleteDocument } from '$lib/services/documentActions';
import { toasts } from '$lib/services/toast';
import { broadcastLocalUpdate, documentRepository } from '$lib/sync';
import { bytesToBase64 } from '$lib/sync/protocol';
import type { ImportResult, ImportTarget, SkipReason } from './importFiles';
import { describeImport } from './report';

/**
 * Importing Markdown files as notes, as the pages start it.
 *
 * Rust opens the dialog and reads the files (`pick_markdown_files`); this
 * side makes the notes, since only it can build a document (ADR 0013). See
 * docs/decisions/0029-import-markdown-files-as-notes.md.
 */

/** What `pick_markdown_files` hands back. */
interface RawPicked {
    files: { name: string; text: string }[];
    unread: { name: string; reason: Exclude<SkipReason, 'failed'> }[];
}

/**
 * The app's side of an import: the calls a note made in the editor goes
 * through, so an imported note is created, saved, indexed and sent to paired
 * devices exactly as one typed in would be.
 */
const appTarget: ImportTarget = {
    async createNote(title) {
        const doc = await createNote(title);
        return { id: doc.id, title: doc.title };
    },

    // What `persistSnapshot` does with an editor's save, but for its toast:
    // an import reports what it could not save once, in its summary. The
    // whole state is the update a peer needs, since all of it is new.
    async saveContent(docId, state, index) {
        await documentRepository.saveLocalUpdate(docId, state, index);
        broadcastLocalUpdate(docId, bytesToBase64(state));
        appStore.markDocumentHasContent(docId);
        appStore.setDocumentCounts(docId, index.todoCount, index.completedTodoCount);
    },

    deleteNote: (docId) => deleteDocument(docId),

    async heldAttachments(hashes) {
        const held = new Set<string>();
        for (const hash of hashes) {
            if (await documentRepository.hasAttachment(hash)) held.add(hash);
        }
        return held;
    },
};

let running = false;

/**
 * Let the user pick Markdown files, and make a note of each.
 *
 * Resolves to null when the dialog is closed. Rejects only when the files
 * could not be picked or read at all; a file that could not become a note is
 * in the result.
 */
export async function importMarkdownFiles(
    onProgress?: (done: number, total: number) => void,
): Promise<ImportResult | null> {
    // One at a time: a second import started from the other page while the
    // first runs would only race it for the same notes list.
    if (running) throw new Error('an import is already running');
    running = true;
    try {
        const picked = await invoke<RawPicked | null>('pick_markdown_files');
        if (!picked) return null;

        // Loaded here rather than with the page: the converter carries a
        // Markdown parser, and most sessions never import anything.
        const { importFiles } = await import('./importFiles');
        const result = await importFiles(picked.files, appTarget, onProgress);
        return { ...result, skipped: [...picked.unread, ...result.skipped] };
    } finally {
        running = false;
    }
}

/**
 * Import, and say how it went. Resolves to the result for the page to act on,
 * or null when there is nothing to act on: the dialog was closed, or the
 * import failed and has already said so.
 */
export async function runMarkdownImport(
    onProgress?: (done: number, total: number) => void,
): Promise<ImportResult | null> {
    let result: ImportResult | null;
    try {
        result = await importMarkdownFiles(onProgress);
    } catch (error) {
        console.error('Failed to import notes:', error);
        toasts.error(`Import failed: ${message(error)}`);
        return null;
    }
    if (!result) return null;

    const report = describeImport(result);
    if (report.success) toasts.success(report.success);
    if (report.failure) toasts.error(report.failure);
    // Longer than a warning's usual four seconds: these name files, and
    // the user may want to find them.
    for (const warning of report.warnings) toasts.warning(warning, 8000);
    return result;
}

// A Tauri command rejects with a string, not an Error.
function message(error: unknown): string {
    if (typeof error === 'string') return error;
    return error instanceof Error ? error.message : 'unknown error';
}
