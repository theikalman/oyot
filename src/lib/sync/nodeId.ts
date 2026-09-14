// A node id is a device's Ed25519 public key, base64url-unpadded: 32 bytes in
// 43 characters. See src-tauri/src/crypto.rs and
// docs/decisions/0009-authenticated-signaling.md.
//
// Checking the shape before pairing is worth doing for two reasons. A typo in a
// hand-entered id would otherwise produce nothing at all: the request would be
// published to a topic nobody is subscribed to, and the user would watch it
// time out with no clue why. And the id becomes an MQTT topic segment, so
// anything outside this alphabet could alter the topic rather than just fail.

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
