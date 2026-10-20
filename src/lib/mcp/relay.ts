// The page's half of answering an MCP client (ADR 0037, decision 6).
//
// Rust answers what the index can, and asks the page for what only the page
// can do: render a note against the editor's schema, and decode or redraw an
// image. It asks with an `mcp-request` event; the answer goes back with
// `mcp_respond`, carrying the request's id. Each read runs as one step of the
// document's write queue, so it sees every write queued before it.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type * as Y from 'yjs';
import { rootFromYDoc } from '$lib/editor/headlessIndex';
import { documentRepository } from '$lib/sync';
import { base64ToBytes, bytesToBase64 } from '$lib/sync/protocol';
import { browserCodec, prepareImage, type Codec } from './images';
import { renderNote, revisionOf } from './noteMarkdown';

interface McpRequest {
    id: number;
    method: string;
    params: Record<string, unknown>;
}

/** What answering needs, so the tests can stand in for the repository and the canvas. */
export interface RelayDeps {
    readDocument<T>(docId: string, read: (ydoc: Y.Doc) => T): Promise<T>;
    codec: Codec;
}

const defaultDeps: RelayDeps = {
    readDocument: (docId, read) => documentRepository.readDocument(docId, read),
    codec: browserCodec,
};

/** Answer Rust's requests until the returned function is called. */
export function watchMcpRequests(deps: RelayDeps = defaultDeps): () => void {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void listen<McpRequest>('mcp-request', (event) => {
        void answer(event.payload, deps);
    })
        .then((stop) => {
            if (stopped) return stop();
            unlisten = stop;
            // Rust holds requests until this, since one sent before the
            // listener is up would be lost.
            return invoke('mcp_page_ready');
        })
        .catch((error) => console.warn('[mcp] not answering assistants:', error));
    return () => {
        stopped = true;
        unlisten?.();
    };
}

async function answer({ id, method, params }: McpRequest, deps: RelayDeps): Promise<void> {
    try {
        const result = await handleMcpRequest(method, params, deps);
        await invoke('mcp_respond', { id, result });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await invoke('mcp_respond', { id, error: message }).catch(() => {});
    }
}

export async function handleMcpRequest(
    method: string,
    params: Record<string, unknown>,
    deps: RelayDeps,
): Promise<unknown> {
    switch (method) {
        case 'readNote': {
            const docId = text(params, 'docId');
            const rendered = await deps.readDocument(docId, (ydoc) =>
                renderNote(rootFromYDoc(ydoc)),
            );
            return {
                markdown: rendered.markdown,
                revision: await revisionOf(rendered.markdown),
                images: rendered.images,
            };
        }
        case 'inlineImage': {
            const docId = text(params, 'docId');
            const id = text(params, 'id');
            const uri = await deps.readDocument(docId, (ydoc) =>
                renderNote(rootFromYDoc(ydoc)).inlineImages.get(id),
            );
            if (!uri) throw new Error(`The note has no inline image ${id}.`);
            return parseDataUri(uri);
        }
        case 'prepareImage': {
            const prepared = await prepareImage(
                base64ToBytes(text(params, 'base64')),
                text(params, 'mime'),
                Number(params.maxBytes),
                deps.codec,
            );
            if (!prepared.ok) return { ok: false, reason: prepared.reason };
            const { image } = prepared;
            return {
                ok: true,
                mime: image.mime,
                base64: bytesToBase64(image.bytes),
                width: image.width,
                height: image.height,
                scaled: image.scaled,
                firstFrameOnly: image.firstFrameOnly,
            };
        }
        default:
            throw new Error(`Oyot's window does not know how to ${method}.`);
    }
}

function text(params: Record<string, unknown>, key: string): string {
    const value = params[key];
    if (typeof value !== 'string') throw new Error(`${key} is missing`);
    return value;
}

/**
 * A `data:` URI's type and bytes, as base64. Most hold base64 already; one
 * that does not, such as an SVG written out as text, is percent-decoded and
 * encoded.
 */
export function parseDataUri(uri: string): { mime: string; base64: string } {
    const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(uri);
    if (!match) throw new Error('The inline image is not a data URI.');
    const mime = match[1] || 'text/plain';
    const isBase64 = match[2].split(';').includes('base64');
    if (isBase64) return { mime, base64: match[3] };
    return { mime, base64: bytesToBase64(new TextEncoder().encode(decodeURIComponent(match[3]))) };
}
