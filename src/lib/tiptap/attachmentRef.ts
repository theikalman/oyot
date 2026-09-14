// How a document refers to an image, and how to read that reference back.
//
// Pure on purpose, and separate from `attachments.ts`, which reaches for Tauri
// and the sync layer. The document index walks every node on the save path and
// on the sync path, and must not pull either of those in behind it.

// What we store in a document for an inserted image. The bytes live outside
// the CRDT (content-addressed by hash); this reference is portable across
// devices, unlike a resolved `asset://`/`http://asset.localhost` path, which is
// machine-local and was the cause of images failing to sync.
export const ATTACHMENT_SCHEME = 'oyot-attachment://';

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
export function attachmentHash(src: string | null | undefined, alt?: string | null): string | null {
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
