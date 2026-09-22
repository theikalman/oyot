import { describe, it, expect } from 'vitest';
import { isObfuscated, rewriteCandidate } from './iceRewrite';

const obfuscated =
    'candidate:842163049 1 udp 2122260223 8d2f1b9e-0a4e-4d21-9a8e-2b6f0c7a1d33.local 51820 typ host generation 0 ufrag Xj4k network-cost 999';
const plain =
    'candidate:842163049 1 udp 2122260223 192.168.1.20 51820 typ host generation 0 ufrag Xj4k';

const init = (candidate: string): RTCIceCandidateInit => ({
    candidate,
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'Xj4k',
});

describe('isObfuscated', () => {
    it('recognises an mDNS name where an address should be', () => {
        expect(isObfuscated(obfuscated)).toBe(true);
    });

    it('leaves a candidate that already names an address alone', () => {
        expect(isObfuscated(plain)).toBe(false);
    });

    it('is not confused by something that is not a candidate', () => {
        expect(isObfuscated('')).toBe(false);
        expect(isObfuscated('candidate:1 2 3')).toBe(false);
    });
});

describe('rewriteCandidate', () => {
    it('puts the address where the mDNS name was', () => {
        const got = rewriteCandidate(init(obfuscated), '100.64.0.9');

        expect(got?.candidate).toContain('100.64.0.9');
        expect(got?.candidate).not.toContain('.local');
    });

    // The port is the one thing in an obfuscated candidate that was never
    // hidden, and it is the whole reason this works.
    it('keeps the port, the transport and everything after them', () => {
        const got = rewriteCandidate(init(obfuscated), '100.64.0.9');

        expect(got?.candidate).toContain(' 51820 typ host');
        expect(got?.candidate).toContain('network-cost 999');
        expect(got?.candidate?.startsWith('candidate:')).toBe(true);
    });

    // ICE treats one foundation as one base, and these are two: the same
    // socket named in a way the peer can use and a way it cannot.
    it('gives the copy a foundation of its own', () => {
        const got = rewriteCandidate(init(obfuscated), '100.64.0.9');

        expect(got?.candidate?.split(' ')[0]).not.toBe(obfuscated.split(' ')[0]);
    });

    it('carries the m-line and ufrag over, or the candidate belongs to nothing', () => {
        const got = rewriteCandidate(init(obfuscated), '100.64.0.9');

        expect(got?.sdpMid).toBe('0');
        expect(got?.sdpMLineIndex).toBe(0);
        expect(got?.usernameFragment).toBe('Xj4k');
    });

    it('does nothing to a candidate that already names an address', () => {
        expect(rewriteCandidate(init(plain), '100.64.0.9')).toBeNull();
    });

    // Mangling something we did not understand would be worse than ignoring
    // it: the original is published either way.
    it('does nothing to what it does not recognise', () => {
        expect(
            rewriteCandidate(init('candidate:1 1 udp 2122 host.local 9'), '100.64.0.9'),
        ).toBeNull();
        expect(rewriteCandidate(init(''), '100.64.0.9')).toBeNull();
        expect(rewriteCandidate({ candidate: undefined }, '100.64.0.9')).toBeNull();
    });

    it('does nothing when there is no address to use', () => {
        expect(rewriteCandidate(init(obfuscated), '')).toBeNull();
    });
});
