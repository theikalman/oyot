import { describe, it, expect } from 'vitest';
import {
    BOOT_ID,
    admitEnvelope,
    parseDescPayload,
    parseIcePayload,
    serializeDesc,
    serializeIce,
    type PeerEpochState,
} from './envelope';

function freshState(): PeerEpochState {
    return { peerBoot: null, peerEpoch: 0 };
}

describe('envelope serialisation', () => {
    it('round-trips a description with our boot id', () => {
        const desc = { type: 'offer', sdp: 'v=0' } as RTCSessionDescriptionInit;
        const parsed = parseDescPayload(serializeDesc(7, desc));
        expect(parsed).toEqual({ boot: BOOT_ID, epoch: 7, description: desc });
    });

    it('round-trips an ICE candidate with our boot id', () => {
        const cand = { candidate: 'candidate:1 1 udp', sdpMid: '0' } as RTCIceCandidateInit;
        const parsed = parseIcePayload(serializeIce(3, cand));
        expect(parsed).toEqual({ boot: BOOT_ID, epoch: 3, candidate: cand });
    });

    it('accepts a payload from a peer that sends no boot id', () => {
        const raw = JSON.stringify({ epoch: 2, description: { type: 'answer' } });
        expect(parseDescPayload(raw)).toEqual({
            boot: undefined,
            epoch: 2,
            description: { type: 'answer' },
        });
    });

    it('rejects a payload with no description or candidate', () => {
        expect(() => parseDescPayload(JSON.stringify({ epoch: 1 }))).toThrow();
        expect(() => parseIcePayload(JSON.stringify({ epoch: 1 }))).toThrow();
    });
});

describe('admitEnvelope', () => {
    it('accepts a rising epoch and records it', () => {
        const state = freshState();
        expect(admitEnvelope(state, { boot: 'a', epoch: 1 })).toBe('accept');
        expect(admitEnvelope(state, { boot: 'a', epoch: 5 })).toBe('accept');
        expect(state.peerEpoch).toBe(5);
    });

    it('rejects an epoch that went backwards within one run', () => {
        const state = freshState();
        admitEnvelope(state, { boot: 'a', epoch: 9 });
        expect(admitEnvelope(state, { boot: 'a', epoch: 4 })).toBe('stale');
        expect(state.peerEpoch).toBe(9);
    });

    it('accepts the same epoch twice', () => {
        // A retransmitted offer is not stale, and rejecting it would strand a
        // negotiation whose first copy was lost.
        const state = freshState();
        admitEnvelope(state, { boot: 'a', epoch: 3 });
        expect(admitEnvelope(state, { boot: 'a', epoch: 3 })).toBe('accept');
    });

    // The bug this exists for: after a flaky session our mark for the peer is
    // high, the peer restarts and begins again at 1, and every message it
    // sends looks stale. It stayed unreachable until its counter climbed back
    // past the mark, one bump per backoff cycle, and Reconnect did not help
    // because it keeps the session and therefore the mark.
    it('accepts a restarted peer whose epoch counter began again', () => {
        const state = freshState();
        for (const epoch of [1, 2, 3, 4, 5]) admitEnvelope(state, { boot: 'before', epoch });
        expect(state.peerEpoch).toBe(5);

        expect(admitEnvelope(state, { boot: 'after', epoch: 1 })).toBe('accept');
        expect(state.peerBoot).toBe('after');
        expect(state.peerEpoch).toBe(1);
    });

    it('still rejects a stale message from the new run', () => {
        const state = freshState();
        admitEnvelope(state, { boot: 'after', epoch: 4 });
        expect(admitEnvelope(state, { boot: 'after', epoch: 2 })).toBe('stale');
    });

    it('does not reset when the boot id is unchanged', () => {
        const state = freshState();
        admitEnvelope(state, { boot: 'a', epoch: 6 });
        admitEnvelope(state, { boot: 'a', epoch: 7 });
        expect(state.peerEpoch).toBe(7);
    });

    it('treats a peer with no boot id as it always did', () => {
        // An older build tags epochs but not runs. It must keep working, just
        // without the restart recovery.
        const state = freshState();
        expect(admitEnvelope(state, { epoch: 5 })).toBe('accept');
        expect(admitEnvelope(state, { epoch: 2 })).toBe('stale');
        expect(state.peerBoot).toBeNull();
    });

    it('lets an untagged message through whatever the mark is', () => {
        const state = freshState();
        admitEnvelope(state, { boot: 'a', epoch: 9 });
        expect(admitEnvelope(state, { boot: 'a', epoch: 0 })).toBe('accept');
    });
});
