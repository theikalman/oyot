import { invoke } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/core';
import '@tiptap/extension-image';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { exitSuggestion } from '@tiptap/suggestion';
import { ATTACHMENT_SCHEME } from '../attachments';
import { broadcastAttachmentAvailable } from '$lib/sync';
import { toasts } from '$lib/services/toast';

// Mirrors MAX_IMAGE_BYTES in src-tauri/src/commands/attachments.rs, which is
// the authority; this is only here to fail fast with a clearer message.
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

function arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
}

export function registerImageCommand(): void {
    const command: SlashCommand = {
        id: 'image',
        label: 'Insert Image',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4.272 20.728 6.597-6.597c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668l6.553 6.553M14 15l2.869-2.869c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668L22 15M10 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6.8 21h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 18.72 22 17.88 22 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 3 18.88 3 17.2 3H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 5.28 2 6.12 2 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 21 5.12 21 6.8 21"/></svg>',
        onSelect: (props: CommandSelectProps) => {
            const range = props.range;
            const ed = props.editor as Editor;

            exitSuggestion(ed.view);
            ed.chain().focus().deleteRange(range).run();

            insertImageFromFile(ed);
        },
    };
    commandRegistry.register(command);
}

export async function insertImageFromFile(editor: Editor): Promise<void> {
    try {
        // Rust opens the dialog, reads the file and stores it. The picked path
        // never crosses IPC, so a script in the webview cannot name a file for
        // this to copy into the attachment store, and the frontend needs no
        // filesystem permission at all. Rust also enforces the size cap and
        // decides the image type from the bytes.
        const stored = await invoke<{ hash: string; mime_type: string; size: number } | null>(
            'pick_and_import_image',
        );
        if (!stored) return; // cancelled
        insertImageNode(editor, stored.hash, stored.mime_type, stored.size);
    } catch (error) {
        console.error('Failed to insert image:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to insert image');
    }
}

export async function insertImageFromBlob(editor: Editor, blob: Blob): Promise<void> {
    if (!validateFileSize(blob)) return;
    if (!ACCEPTED_MIME.has(blob.type)) {
        toasts.error('Only PNG, JPEG, GIF and WebP images are supported');
        return;
    }

    try {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const base64 = arrayBufferToBase64(uint8Array);

        const hash: string = await invoke('save_image', {
            imageData: base64,
            mimeType: blob.type,
        });

        insertImageNode(editor, hash, blob.type, blob.size);
    } catch (error) {
        console.error('Failed to insert image:', error);
        toasts.error(typeof error === 'string' ? error : 'Failed to insert image');
    }
}

// Store only a portable reference in the document. The node view
// (ResizableImage) resolves it to a local URL at render time, and the sync
// layer moves the bytes between devices.
function insertImageNode(editor: Editor, hash: string, mimeType: string, size: number): void {
    editor
        .chain()
        .focus()
        .setImage({
            src: `${ATTACHMENT_SCHEME}${hash}`,
            alt: `oyot:${hash}`,
        })
        .run();

    try {
        broadcastAttachmentAvailable(hash, mimeType, size);
    } catch {
        /* sync layer not initialised */
    }
}

function validateFileSize(blob: Blob): boolean {
    if (blob.size > MAX_IMAGE_SIZE) {
        toasts.error('Image is too large. Maximum size is 10MB.');
        return false;
    }
    return true;
}
