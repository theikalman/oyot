import { invoke } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/core';
import { toasts } from '$lib/services/toast';
import { insertImagesAt } from './ImageCommand';

/** What Rust says of files dropped on the window (`FilesDropped`). */
export interface FilesDropped {
    token: string;
    count: number;
    /** Where they were dropped, in the page's own pixels. */
    x: number;
    y: number;
}

/** Told by Rust when files a note takes are dropped on the window. */
export const FILES_DROPPED_EVENT = 'files-dropped';

/**
 * Where in `editor` a drop at (x, y) lands, or null when it is not on this
 * editor or the editor cannot be written in, and so takes nothing.
 *
 * `area` is the note's whole writing area, of which the editor itself is only
 * as tall as what is written: a drop in the space below a short note goes in
 * at its end.
 */
export function dropPosition(
    editor: Editor,
    x: number,
    y: number,
    area: Element | null = null,
): number | null {
    if (!editor.isEditable) return null;
    const dom = editor.view.dom;
    const under = document.elementFromPoint(x, y);
    if (!under || !(dom.contains(under) || area?.contains(under))) return null;
    const box = dom.getBoundingClientRect();
    const at = editor.view.posAtCoords({
        left: clamp(x, box.left + 1, box.right - 1),
        top: clamp(y, box.top + 1, box.bottom - 1),
    });
    return at?.pos ?? null;
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Add files dropped on the window from the system, when they were dropped on
 * this editor while it can be written in. On a computer the page never sees
 * such a file: Tauri takes the drop, and Rust holds its paths until the page
 * names the drop by the token it was told. The page never names a path.
 */
export async function acceptDroppedFiles(
    editor: Editor,
    drop: FilesDropped,
    area: Element | null = null,
): Promise<void> {
    const at = dropPosition(editor, drop.x, drop.y, area);
    if (at === null) return;
    try {
        const result = await invoke<{ images: { hash: string }[]; failed: string[] }>(
            'accept_dropped_files',
            { token: drop.token },
        );
        insertImagesAt(
            editor,
            result.images.map((image) => image.hash),
            at,
        );
        for (const reason of result.failed) toasts.error(reason);
    } catch (error) {
        console.error('Failed to add dropped files:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to add dropped files');
    }
}
