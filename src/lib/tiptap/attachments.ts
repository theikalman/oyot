import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pullAttachmentFromPeers } from '$lib/sync';

// What we store in a document for an inserted image. The bytes live outside the
// CRDT (content-addressed by hash); this reference is portable across devices,
// unlike a resolved `asset://`/`http://asset.localhost` path, which is
// machine-local and was the cause of images failing to sync.
export const ATTACHMENT_SCHEME = 'oyot-attachment://';

// 1x1 transparent GIF. Shown while an attachment's bytes are not yet on this
// device - keeps the <img> load event firing and avoids a failed request in the
// console for the unresolved scheme.
export const PENDING_IMAGE_SRC =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const HEX64 = /([a-f0-9]{64})/i;

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

// Recover an attachment's content hash from any form a document may hold:
//   - oyot-attachment://<hash>                             (current)
//   - alt="oyot:<hash>"                                    (every version)
//   - .../attachments/<hash>.<ext> baked asset URL         (legacy regression)
export function attachmentHash(
    src: string | null | undefined,
    alt?: string | null,
): string | null {
    if (src && src.startsWith(ATTACHMENT_SCHEME)) {
        return src.slice(ATTACHMENT_SCHEME.length).toLowerCase() || null;
    }
    if (alt && alt.startsWith('oyot:')) {
        const m = alt.slice(5).match(HEX64);
        if (m) return m[1].toLowerCase();
    }
    if (src) {
        const decoded = safeDecode(src);
        if (decoded.includes('attachments')) {
            const m = decoded.match(HEX64);
            if (m) return m[1].toLowerCase();
        }
    }
    return null;
}

// A `src` that is neither our scheme nor an inline data URI - i.e. a legacy
// baked local path that must be rewritten to the portable scheme.
export function isLegacyBakedSrc(src: string | null | undefined): boolean {
    return !!src && !src.startsWith(ATTACHMENT_SCHEME) && !src.startsWith('data:');
}

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

// Mark an attachment as wanted and ask connected peers for it now.
export function requestAttachment(hash: string): void {
    invoke('request_attachment', { hash }).catch(() => {});
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
