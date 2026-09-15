import { describe, it, expect } from 'vitest';
import { canReachForPairing, unreachableForPairing, type ReachInputs } from './pairReach';

const base: ReachInputs = {
    onLocalNetwork: false,
    brokerConfigured: false,
    brokerStatus: 'disconnected',
    mode: 'auto',
};

describe('canReachForPairing', () => {
    it('a device found on this network can be paired with, broker or not', () => {
        expect(canReachForPairing({ ...base, onLocalNetwork: true })).toBe(true);
    });

    it('a connected broker reaches a device that is not on this network', () => {
        expect(canReachForPairing({ ...base, brokerStatus: 'connected' })).toBe(true);
    });

    // The reported failure: no broker at all, and the other device not yet
    // found, which is the normal state for the first second after it starts.
    it('nothing found and no broker cannot be paired with', () => {
        expect(canReachForPairing(base)).toBe(false);
    });

    it('local-only ignores a connected broker', () => {
        const got = canReachForPairing({ ...base, brokerStatus: 'connected', mode: 'local-only' });
        expect(got).toBe(false);
    });

    it('local-only still pairs with a device on this network', () => {
        const got = canReachForPairing({ ...base, onLocalNetwork: true, mode: 'local-only' });
        expect(got).toBe(true);
    });
});

describe('unreachableForPairing', () => {
    // A person with no broker should not be told their network is at fault,
    // and a person with one should not be told to go and find a network.
    it('says there is no broker when none is configured', () => {
        expect(unreachableForPairing(base)).toContain('no broker is configured');
    });

    it('says the broker is not connected when one is configured', () => {
        const got = unreachableForPairing({
            ...base,
            brokerConfigured: true,
            brokerStatus: 'error',
        });
        expect(got).toContain('broker is not connected');
    });

    it('asks for patience while the broker is still connecting', () => {
        const got = unreachableForPairing({
            ...base,
            brokerConfigured: true,
            brokerStatus: 'connecting',
        });
        expect(got).toContain('Try again in a moment');
    });

    it('explains the setting rather than the network under local-only', () => {
        const got = unreachableForPairing({ ...base, mode: 'local-only' });
        expect(got).toContain('local network only');
    });

    it('always names what was not found', () => {
        for (const mode of ['auto', 'local-only'] as const) {
            expect(unreachableForPairing({ ...base, mode })).toContain('has not appeared');
        }
    });
});
