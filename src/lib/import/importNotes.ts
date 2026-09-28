import { invoke } from '@tauri-apps/api/core';
import {
    createImportedNote,
    deleteDocument,
    publishImportedNotes,
} from '$lib/services/documentActions';
import { toasts } from '$lib/services/toast';
import { documentRepository } from '$lib/sync';
import type { Document } from '$lib/types';
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
 * The app's side of an import, made afresh for each one: `documentActions`
 * to make, list and announce the notes, and the repository to merge their
 * content in, as it merges a peer's. It holds on to each note's row until the
 * note is listed.
 */
function appTarget(): ImportTarget {
    const rows = new Map<string, Document>();
    return {
        async createNote(id, title) {
            rows.set(id, await createImportedNote(id, title));
        },
        saveContent: (id, update) => documentRepository.importContent(id, update),
        publish(notes) {
            publishImportedNotes(
                notes.flatMap(({ id, hasContent, index }) => {
                    const doc = rows.get(id);
                    rows.delete(id);
                    return doc ? [{ doc, hasContent, index }] : [];
                }),
            );
        },
        deleteNote: (id) => deleteDocument(id),
        async heldAttachments(hashes) {
            const held = new Set<string>();
            for (const hash of hashes) {
                if (await documentRepository.hasAttachment(hash)) held.add(hash);
            }
            return held;
        },
    };
}

/**
 * Let the user pick Markdown files, and make a note of each.
 *
 * Resolves to null when the dialog is closed. Rejects only when the files
 * could not be picked or read at all; a file that could not become a note is
 * in the result. One import runs at a time, which `markdownImport` in
 * ./importState.svelte.ts sees to.
 */
export async function importMarkdownFiles(
    onProgress?: (done: number, total: number) => void,
): Promise<ImportResult | null> {
    const picked = await invoke<RawPicked | null>('pick_markdown_files');
    if (!picked) return null;

    // Loaded here rather than with the page: the converter carries a
    // Markdown parser, and most sessions never import anything.
    const { importFiles } = await import('./importFiles');
    const result = await importFiles(picked.files, appTarget(), onProgress);
    return { ...result, skipped: [...picked.unread, ...result.skipped] };
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
    // Longer than a warning's usual four seconds: these name files, and
    // the user may want to find them.
    for (const warning of report.warnings) toasts.warning(warning, 8000);
    // Last, so it is the newest toast: shown first, and the last to make way
    // when there are more than fit.
    if (report.imported) toasts.success(report.headline);
    else toasts.error(report.headline);
    return result;
}

// A Tauri command rejects with a string, not an Error.
function message(error: unknown): string {
    if (typeof error === 'string') return error;
    return error instanceof Error ? error.message : 'unknown error';
}
