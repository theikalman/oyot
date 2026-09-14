import { describe, it, expect } from 'vitest';
import {
    RECONNECT_MAX_MS,
    isPolite,
    reconnectDelay,
    shouldSweep,
    type SweepCandidate,
} from './negotiation';

describe('isPolite', () => {
    it('makes the two devices disagree, which is the point', () => {
        // Exactly one of a pair must yield, or a collision is never resolved.
        const a = 'aaa';
        const b = 'bbb';
        expect(isPolite(a, b)).not.toBe(isPolite(b, a));
    });

    it('gives the same answer every time for the same pair', () => {
        expect(isPolite('zzz', 'aaa')).toBe(true);
        expect(isPolite('aaa', 'zzz')).toBe(false);
    });

    it('is a total order over real node ids', () => {
        // node_ids are base64url, so they can contain '-' and '_', which sort
        // either side of the alphanumerics. Any pair must still resolve.
        const ids = ['A-b', 'A_b', 'Aab', 'zzz', '0aa'];
        for (const x of ids) {
            for (const y of ids) {
                if (x === y) continue;
                expect(isPolite(x, y)).not.toBe(isPolite(y, x));
            }
        }
    });
});

describe('reconnectDelay', () => {
    it('doubles with each attempt', () => {
        expect(reconnectDelay(0)).toBe(1_000);
        expect(reconnectDelay(1)).toBe(2_000);
        expect(reconnectDelay(2)).toBe(4_000);
        expect(reconnectDelay(3)).toBe(8_000);
    });

    it('stops doubling at the cap', () => {
        expect(reconnectDelay(20)).toBe(RECONNECT_MAX_MS);
        // Also no overflow into something absurd for a long outage.
        expect(Number.isFinite(reconnectDelay(200))).toBe(true);
        expect(reconnectDelay(200)).toBe(RECONNECT_MAX_MS);
    });

    it('adds the jitter it is given', () => {
        expect(reconnectDelay(0, 250)).toBe(1_250);
        expect(reconnectDelay(20, 250)).toBe(RECONNECT_MAX_MS + 250);
    });

    it('treats a negative attempt as the first', () => {
        expect(reconnectDelay(-1)).toBe(1_000);
    });
});

describe('shouldSweep', () => {
    const base: SweepCandidate = {
        peerNodeId: 'peer',
        roomId: 'room',
        connected: false,
        suppressed: false,
    };

    it('skips a peer that is already up', () => {
        expect(shouldSweep({ ...base, connected: true })).toBe(false);
    });

    it('skips a peer the user disconnected', () => {
        expect(shouldSweep({ ...base, suppressed: true })).toBe(false);
    });

    it('leaves a handshake in progress alone', () => {
        expect(shouldSweep({ ...base, connectionState: 'connecting' })).toBe(false);
        expect(shouldSweep({ ...base, connectionState: 'connected' })).toBe(false);
    });

    // The case the negotiation watchdog depends on: an offer whose answer was
    // lost leaves the connection in `new` for ever, so the sweep has to be
    // willing to take it.
    it('takes a connection stuck before negotiation completed', () => {
        expect(shouldSweep({ ...base, connectionState: 'new' })).toBe(true);
    });

    it('takes a failed or closed connection', () => {
        expect(shouldSweep({ ...base, connectionState: 'failed' })).toBe(true);
        expect(shouldSweep({ ...base, connectionState: 'closed' })).toBe(true);
        expect(shouldSweep({ ...base, connectionState: 'disconnected' })).toBe(true);
    });

    it('takes a peer with no session at all', () => {
        expect(shouldSweep(base)).toBe(true);
    });
});
