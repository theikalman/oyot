import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/core';
import '@tiptap/extension-image';
import { commandRegistry, type SlashCommand, type CommandSelectProps } from '../CommandRegistry';
import { exitSuggestion } from '@tiptap/suggestion';
import { ATTACHMENT_SCHEME } from '../attachments';
import { broadcastAttachmentAvailable } from '$lib/sync';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

function arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
}

function getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml'
    };
    return mimeTypes[ext ?? ''] ?? 'image/png';
}

export function registerImageCommand(editor: Editor): void {
    const command: SlashCommand = {
        id: 'image',
        label: 'Insert Image',
        icon: '<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4.272 20.728 6.597-6.597c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668l6.553 6.553M14 15l2.869-2.869c.396-.396.594-.594.822-.668a1 1 0 0 1 .618 0c.228.074.426.272.822.668L22 15M10 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6.8 21h10.4c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C22 18.72 22 17.88 22 16.2V7.8c0-1.68 0-2.52-.327-3.162a3 3 0 0 0-1.311-1.311C19.72 3 18.88 3 17.2 3H6.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C2 5.28 2 6.12 2 7.8v8.4c0 1.68 0 2.52.327 3.162a3 3 0 0 0 1.311 1.311C4.28 21 5.12 21 6.8 21"/></svg>',
        onTrigger: () => {},
        onSelect: (props: CommandSelectProps) => {
            const range = props.range;
            const ed = props.editor as Editor;

            exitSuggestion(ed.view);
            ed.chain().focus().deleteRange(range).run();

            insertImageFromFile(ed);
        }
    };
    commandRegistry.register(command);
}

export async function insertImageFromFile(editor: Editor): Promise<void> {
    const filePath = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
    });

    if (!filePath) return;

    try {
        const fileContent = await readFile(filePath);
        const mimeType = getMimeType(filePath);
        const blob = new Blob([fileContent], { type: mimeType });

        if (!validateFileSize(blob)) return;

        const base64 = arrayBufferToBase64(fileContent);

        const hash: string = await invoke('save_image', {
            imageData: base64,
            mimeType
        });

        insertImageNode(editor, hash, mimeType, blob.size);
    } catch (error) {
        console.error('Failed to insert image:', error);
        alert('Failed to insert image. Please try again.');
    }
}

export async function insertImageFromBlob(editor: Editor, blob: Blob): Promise<void> {
    if (!validateFileSize(blob)) return;

    try {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const base64 = arrayBufferToBase64(uint8Array);

        const hash: string = await invoke('save_image', {
            imageData: base64,
            mimeType: blob.type
        });

        insertImageNode(editor, hash, blob.type, blob.size);
    } catch (error) {
        console.error('Failed to insert image:', error);
    }
}

// Store only a portable reference in the document. The node view
// (ResizableImage) resolves it to a local URL at render time, and the sync
// layer moves the bytes between devices.
function insertImageNode(editor: Editor, hash: string, mimeType: string, size: number): void {
    editor.chain().focus().setImage({
        src: `${ATTACHMENT_SCHEME}${hash}`,
        alt: `oyot:${hash}`
    }).run();

    try {
        broadcastAttachmentAvailable(hash, mimeType, size);
    } catch {
        /* sync layer not initialised */
    }
}

function validateFileSize(blob: Blob): boolean {
    if (blob.size > MAX_IMAGE_SIZE) {
        alert('Image file is too large. Maximum size is 10MB.');
        return false;
    }
    return true;
}
