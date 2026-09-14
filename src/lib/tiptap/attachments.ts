import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pullAttachmentFromPeers } from '$lib/sync';

// The pure half lives in ./attachmentRef so the document index can read a
// reference without importing Tauri or the sync layer. Re-exported here
// because this is where callers already look for it.
export { ATTACHMENT_SCHEME, attachmentHash, isLegacyBakedSrc } from './attachmentRef';

// 1x1 transparent GIF. Shown while an attachment's bytes are not yet on this
// device - keeps the <img> load event firing and avoids a failed request in
// the console for the unresolved scheme.
export const PENDING_IMAGE_SRC =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// A local displayable URL for an attachment, or null if the bytes are not on
// this device yet.
export async function resolveAttachmentSrc(hash: string): Promise<string | null> {
    try {
        const localPath = await invoke<string | null>('get_local_blob_url', { hash });
        return localPath ? convertFileSrc(localPath) : null;
    } catch {
        return null;
    }
}

// Ask connected peers for an attachment we are missing.
//
// There used to be a `request_attachment` command alongside this, flipping
// `is_fully_downloaded` to 0. It was a no-op on the device that needs the
// bytes, because no row exists there until they arrive, and now that orphan
// collection works off references it has nothing left to mean.
export function requestAttachment(hash: string): void {
    try {
        pullAttachmentFromPeers(hash);
    } catch {
        /* sync layer not initialised (e.g. tests) */
    }
}

// --- "bytes arrived" bus: node views subscribe by hash, one global listener ---

type Callback = () => void;
const subscribers = new Map<string, Set<Callback>>();
let listenerStarted = false;

function ensureListener(): void {
    if (listenerStarted) return;
    listenerStarted = true;
    void listen<{ hash: string }>('attachment-downloaded', (event) => {
        const set = subscribers.get(event.payload.hash);
        if (set) for (const cb of [...set]) cb();
    });
}

export function onAttachmentReady(hash: string, cb: Callback): () => void {
    ensureListener();
    let set = subscribers.get(hash);
    if (!set) {
        set = new Set();
        subscribers.set(hash, set);
    }
    set.add(cb);
    return () => {
        set!.delete(cb);
        if (set!.size === 0) subscribers.delete(hash);
    };
}
