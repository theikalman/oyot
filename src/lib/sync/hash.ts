import { bytesToBase64 } from './protocol';

// Content hash used as the sync change-detector. Two documents with byte-equal
// merged Yjs state hash equally on every device (Yjs update encoding is
// deterministic for a given operation set), so an equal hash in a peer's
// manifest means "identical, skip". The digest is defined entirely on the
// frontend - Rust only stores the bytes we give it.
export async function contentHash(state: Uint8Array): Promise<Uint8Array> {
    // Copy into a standalone ArrayBuffer - `state` may be a view over a larger
    // shared buffer (e.g. a Yjs encoder output slice).
    const buf = state.slice().buffer;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(digest);
}

export async function contentHashBase64(state: Uint8Array): Promise<string> {
    return bytesToBase64(await contentHash(state));
}
