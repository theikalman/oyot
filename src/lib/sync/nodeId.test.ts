import { describe, it, expect } from 'vitest';
import { isValidNodeId, nodeIdError, NODE_ID_LENGTH } from './nodeId';

// 43 base64url characters, the encoding of a 32-byte Ed25519 public key.
const VALID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

describe('isValidNodeId', () => {
    it('accepts a well-formed id', () => {
        expect(VALID).toHaveLength(NODE_ID_LENGTH);
        expect(isValidNodeId(VALID)).toBe(true);
    });

    it('accepts the whole base64url alphabet', () => {
        const alphabet = '-_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const id = alphabet.slice(0, NODE_ID_LENGTH);
        expect(id).toHaveLength(NODE_ID_LENGTH);
        expect(isValidNodeId(id)).toBe(true);
    });

    it('rejects the wrong length', () => {
        expect(isValidNodeId(VALID.slice(0, 42))).toBe(false);
        expect(isValidNodeId(VALID + 'X')).toBe(false);
        expect(isValidNodeId('')).toBe(false);
    });

    // The old node_id was a UUID. Pasting one in should be rejected clearly
    // rather than published to a topic nobody listens on.
    it('rejects a legacy UUID', () => {
        expect(isValidNodeId('3f8a1c2e-9b4d-4f1a-8e7c-2d6b5a4f3e1c')).toBe(false);
    });

    // base64url has no +, / or =, and MQTT topics treat / + # specially.
    it('rejects characters that are unsafe in an MQTT topic', () => {
        for (const ch of ['/', '+', '#', '=', ' ']) {
            expect(isValidNodeId(VALID.slice(0, 42) + ch)).toBe(false);
        }
    });
});

describe('nodeIdError', () => {
    it('returns null for a valid id', () => {
        expect(nodeIdError(VALID)).toBeNull();
        expect(nodeIdError(`  ${VALID}  `)).toBeNull();
    });

    it('asks for input when empty', () => {
        expect(nodeIdError('')).toMatch(/Enter/);
        expect(nodeIdError('   ')).toMatch(/Enter/);
    });

    it('names the expected and actual length when the length is wrong', () => {
        const err = nodeIdError('too-short');
        expect(err).toContain(String(NODE_ID_LENGTH));
        expect(err).toContain('9');
    });

    it('reports a right-length id with bad characters distinctly', () => {
        const err = nodeIdError(VALID.slice(0, 42) + '/');
        expect(err).toBe('That does not look like a device ID');
    });
});
