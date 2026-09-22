// A node id is a device's Ed25519 public key, base64url-unpadded: 32 bytes in
// 43 characters. See src-tauri/src/crypto.rs and
// docs/decisions/0009-authenticated-signaling.md.
//
// Checking the shape before pairing is worth doing because a typo in a
// hand-entered id otherwise produces nothing at all: no device on the network
// answers to it, and the user watches the request time out with no clue why.
// The alphabet is deliberately free of punctuation; see `encode_node_id` in
// src-tauri/src/crypto.rs for why that is still worth keeping.

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const NODE_ID_LENGTH = 43;

export function isValidNodeId(value: string): boolean {
    return NODE_ID_PATTERN.test(value);
}

// A message explaining why an id was rejected, or null when it is fine.
export function nodeIdError(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return 'Enter the other device’s ID';
    if (isValidNodeId(trimmed)) return null;
    if (trimmed.length !== NODE_ID_LENGTH) {
        return `A device ID is ${NODE_ID_LENGTH} characters; this one is ${trimmed.length}`;
    }
    return 'That does not look like a device ID';
}
