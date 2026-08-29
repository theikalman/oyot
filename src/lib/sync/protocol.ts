// Wire protocol for peer-to-peer document sync over a WebRTC data channel.
//
// A connection reconciles the *entire* document set in two phases:
//   1. Manifest  - each peer sends every document it knows (tombstones included)
//                  with a content hash and title timestamp.
//   2. Delta     - for each document whose hashes differ, the receiver asks with
//                  its Yjs state vector and the holder replies with exactly the
//                  missing update.
// Both peers run both phases, so the set converges in both directions. Live
// create/rename/delete/edit messages are a steady-state latency optimisation on
// top - correctness comes from phases 1 and 2 re-running on every (re)connect.
//
// See docs/decisions/0003-full-document-set-sync.md.

// v3 adds attachment (image binary) reconciliation (`attach-*`) and makes every
// `sync-need` get an answer (`sync-none` when the holder has no delta). A v2
// peer speaks neither; the `hello` mismatch already surfaces it as "needs
// updating".
export const SYNC_PROTOCOL_VERSION = 3;

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
    // base64(SHA-256(merged Yjs state)); null when unknown (pre-migration row or
    // never-saved doc) - treated as "force a state-vector exchange".
    contentHash: string | null;
}

// One attachment as advertised in an `attach-manifest`. Mirrors the Rust
// `AttachmentManifestEntry` (commands/attachments.rs).
export interface AttachmentManifestEntry {
    hash: string; // hex SHA-256 of the bytes; also the content address
    mime: string;
    size: number;
}

export type SyncMessage =
    | { t: 'hello'; v: number }
    | { t: 'sync-manifest'; docs: ManifestEntry[] }
    // sv = base64(Y.encodeStateVector(doc)); "" means "I have nothing, send all".
    | { t: 'sync-need'; id: string; sv: string }
    // update = base64(Y.encodeStateAsUpdate(doc, remoteSv)); framing layer chunks it.
    | { t: 'sync-delta'; id: string; update: string }
    // answer to a `sync-need` when the holder has nothing the asker is missing
    // (asker is equal-or-ahead). Lets the asker settle the doc at once instead
    // of waiting out two `sync-need` timeouts.
    | { t: 'sync-none'; id: string }
    // sender has emitted every `sync-need` it intends to.
    | { t: 'sync-done' }
    // --- steady-state optimisations ---
    | { t: 'doc-created'; entry: ManifestEntry }
    | { t: 'doc-renamed'; id: string; title: string; titleUpdatedAt: number }
    | { t: 'doc-deleted'; id: string; deletedAt: number }
    | { t: 'live-update'; id: string; update: string }
    // --- attachments (v3) ---
    // Every attachment the sender holds in full. Sent on connect (alongside
    // `sync-manifest`) and again as a one-item list when a new image is added.
    | { t: 'attach-manifest'; items: AttachmentManifestEntry[] }
    // Receiver asks the holder for the bytes of one attachment.
    | { t: 'attach-need'; hash: string }
    // Holder replies with the bytes (base64); framing layer chunks it.
    | { t: 'attach-data'; hash: string; mime: string; data: string }
    // Holder no longer has the bytes - stop asking this connection.
    | { t: 'attach-missing'; hash: string };

export function isSyncMessage(v: unknown): v is SyncMessage {
    return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

// --- base64 <-> bytes (shared by the repository and the framing layer) --------

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
    }
    return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
