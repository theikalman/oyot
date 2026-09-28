// What the page shares with the sync protocol, which Rust speaks (ADR 0031;
// sync/protocol.rs). A manifest entry is how a document describes itself to a
// peer, and how a backup describes the documents it holds, so importing one
// reconciles against this device's entries by the rules sync uses
// (reconcile.ts). See docs/decisions/0003-full-document-set-sync.md.

// One document as advertised in a `sync-manifest`. Mirrors the Rust
// `DocSyncEntry` (commands/documents.rs) with hashes already base64-encoded.
export interface ManifestEntry {
    id: string;
    docType: string;
    title: string;
    titleUpdatedAt: number;
    createdAt: number;
    isDeleted: boolean;
    deletedAt: number | null;
    // When this device last observed a change to `isDeleted`, in either
    // direction. Makes the delete flag a last-writer-wins register so a
    // revival can beat an older tombstone. Optional on the wire: a peer on an
    // older build omits it, and `lifecycleStamp()` falls back.
    lifecycleUpdatedAt?: number;
    // Whether the document is pinned to the sidebar, and when that was last
    // set: a last-writer-wins register like the title (ADR 0027). Optional on
    // the wire, because a peer on a build from before pins sends neither, and
    // `pinStamp()` reads that as never pinned.
    pinned?: boolean;
    pinnedUpdatedAt?: number | null;
    // base64 of the content hash (ADR 0033); null when unknown, which is
    // treated as "exchange state vectors".
    contentHash: string | null;
}

// The stamp to compare when deciding whether a tombstone or a revival is the
// later observation. Falls back through the timestamps an older peer does send,
// so a manifest without `lifecycleUpdatedAt` still orders sensibly.
export function lifecycleStamp(entry: {
    lifecycleUpdatedAt?: number;
    deletedAt?: number | null;
    titleUpdatedAt?: number;
    createdAt?: number;
}): number {
    return (
        entry.lifecycleUpdatedAt ?? entry.deletedAt ?? entry.titleUpdatedAt ?? entry.createdAt ?? 0
    );
}

// The stamp to compare when deciding whose pin wins. Zero for a document
// nobody has pinned, which is also how a manifest from before pins reads.
export function pinStamp(entry: { pinnedUpdatedAt?: number | null }): number {
    return entry.pinnedUpdatedAt ?? 0;
}

// Yjs' encoding of "no missing operations": a bare, empty update. An update
// this short carries no content, so it is not worth persisting or sending.
export const EMPTY_UPDATE_LEN = 2;

// The content hash of a document with nothing in it (ADR 0033, decision 4).
// Rust computes every hash; this one is spelled out so the page can tell an
// empty document from one whose hash is unknown, which is what a missing hash
// means. crdt.rs and the interop test both pin it to the definition.
export const EMPTY_CONTENT_HASH = 'ah3hKNJyMsJEp/6RKVqPp83Gx1jymaAbctmSIACZgio=';

// --- base64 <-> bytes, how Yjs state crosses IPC ------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + chunk) as unknown as number[],
        );
    }
    return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
