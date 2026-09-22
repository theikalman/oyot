import { invoke } from '@tauri-apps/api/core';
import * as Y from 'yjs';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { extractDocumentIndex } from '$lib/editor/documentIndex';
import { base64ToBytes } from '$lib/sync/protocol';
import type { DocumentSummary, IndexData } from '$lib/types';
import { assignNoteNames } from './filenames';
import { serializeDocument } from './markdown';
import { renderNote } from './note';

/**
 * Exporting every note as an archive of Markdown files.
 *
 * The rendering happens here and the filesystem work happens in Rust, which is
 * the split the rest of the app already has: content lives in the CRDT and
 * only this side can render it (ADR 0013), while the webview has no filesystem
 * permission and is not given one. See
 * docs/decisions/0021-export-notes-as-a-markdown-archive.md.
 */

/** What Rust hands back once the archive is on disk. */
interface RawExportResult {
    path: string;
    note_count: number;
    attachment_count: number;
}

export interface ExportSummary {
    /** Where the archive was written. */
    path: string;
    noteCount: number;
    /** Images written into the archive. */
    attachmentCount: number;
    /**
     * Images a note refers to whose bytes are not on this device, so they
     * could not be included. Non-zero means some other device holds them and
     * this one has not pulled them yet.
     */
    missingAttachmentCount: number;
    /**
     * Notes that could not be rendered, by title. A document whose content
     * this build cannot parse is still listed in the archive - with its front
     * matter and nothing under it - rather than silently left out.
     */
    failedTitles: string[];
}

/** One note, ready for Rust to write. */
interface PreparedNote {
    name: string;
    markdown: string;
    /**
     * When the note was last saved. Carried so the file inside the archive is
     * dated when it was written rather than when it was exported, which is
     * what a folder of exported notes sorted by date should show.
     */
    updatedAt: number;
}

/**
 * Where an image lives relative to a note, given a note is at `notes/x.md`
 * and images are at `attachments/`.
 */
const ATTACHMENT_PREFIX = '../attachments/';

/**
 * Render every note and write them, with their images, to a zip the user
 * picks.
 *
 * Resolves to null when the user cancels the save dialog. Rejects only when
 * the archive could not be written: a document that fails to render is
 * reported in the summary, because losing one note out of three hundred is not
 * a reason to give the user nothing.
 */
export async function exportAllNotes(): Promise<ExportSummary | null> {
    const { documents } = await invoke<IndexData>('get_all_documents');
    if (documents.length === 0) {
        throw new Error('There are no notes to export.');
    }

    // Rust decides what an attachment file is called, because the extension
    // follows the stored mime type. Asking first means the links written below
    // and the files in the archive are named by the same code.
    const available = await invoke<{ hash: string; filename: string }[]>('list_export_attachments');
    const attachmentFiles = new Map(available.map((entry) => [entry.hash, entry.filename]));

    // Oldest first, so a collision on two notes called "Ideas" gives the
    // suffix to the newer one. The sidebar's order is the opposite.
    const ordered = [...documents].sort((a, b) => a.created_at - b.created_at);
    const noteNames = assignNoteNames(ordered.map((doc) => ({ id: doc.id, title: doc.title })));

    const notes: PreparedNote[] = [];
    const usedAttachments = new Set<string>();
    const missingAttachments = new Set<string>();
    const failedTitles: string[] = [];

    for (const doc of ordered) {
        const name = noteNames.get(doc.id);
        if (!name) continue; // unreachable: every id was just named
        const rendered = await renderOne(doc, noteNames, attachmentFiles);
        if (rendered.failed) failedTitles.push(doc.title || 'Untitled');
        for (const hash of rendered.attachments) usedAttachments.add(hash);
        for (const hash of rendered.missing) missingAttachments.add(hash);
        notes.push({ name, markdown: rendered.markdown, updatedAt: doc.updated_at });
    }

    const result = await invoke<RawExportResult | null>('export_notes', {
        notes,
        attachments: [...usedAttachments],
    });
    if (!result) return null;

    return {
        path: result.path,
        noteCount: result.note_count,
        attachmentCount: result.attachment_count,
        missingAttachmentCount: missingAttachments.size,
        failedTitles,
    };
}

interface RenderedNote {
    markdown: string;
    /** Hashes whose bytes are in the archive. */
    attachments: string[];
    /** Hashes referenced but not held on this device. */
    missing: string[];
    failed: boolean;
}

/**
 * One document, rendered.
 *
 * A failure here yields the front matter alone rather than propagating: the
 * export is of everything, and a single document this build cannot parse
 * should cost that document's body and nothing else.
 */
async function renderOne(
    doc: DocumentSummary,
    noteNames: Map<string, string>,
    attachmentFiles: Map<string, string>,
): Promise<RenderedNote> {
    const attachments: string[] = [];
    const missing: string[] = [];

    let body = '';
    let tags: string[] = [];
    let failed = false;

    try {
        const { state } = await invoke<{ doc_id: string; state: string }>('get_yjs_state', {
            docId: doc.id,
        });
        const ydoc = new Y.Doc();
        try {
            if (state) Y.applyUpdate(ydoc, base64ToBytes(state));
            const root = rootFromYDoc(ydoc);
            // The tags come from the same walk the indexer uses, so the front
            // matter says what the tag pages say.
            tags = extractDocumentIndex(root).tags;
            body = serializeDocument(root, {
                attachmentPath: (hash) => {
                    const filename = attachmentFiles.get(hash);
                    if (!filename) {
                        missing.push(hash);
                        return null;
                    }
                    attachments.push(hash);
                    return ATTACHMENT_PREFIX + filename;
                },
                notePath: (targetId) => noteNames.get(targetId) ?? null,
            });
        } finally {
            ydoc.destroy();
        }
    } catch (e) {
        console.warn(`[export] could not render ${doc.id}:`, e);
        failed = true;
    }

    const markdown = renderNote(
        {
            id: doc.id,
            title: doc.title,
            docType: doc.doc_type,
            createdAt: doc.created_at,
            updatedAt: doc.updated_at,
            tags,
        },
        body,
    );

    return { markdown, attachments, missing, failed };
}
