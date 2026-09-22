import { describe, it, expect } from 'vitest';
import { canReachForPairing, unreachableForPairing, type ReachInputs } from './pairReach';

const base: ReachInputs = {
    onLocalNetwork: false,
    discovering: true,
};

describe('canReachForPairing', () => {
    it('a device found on this network can be paired with', () => {
        expect(canReachForPairing({ ...base, onLocalNetwork: true })).toBe(true);
    });

    // The reported failure: the other device not yet found, and since ADR 0022
    // nothing else to fall back on.
    it('a device that has not been found cannot be paired with', () => {
        expect(canReachForPairing(base)).toBe(false);
    });

    it('being found is enough even while discovery is reported off', () => {
        // The peer table is only populated by discovery, so this combination
        // should not arise; if it does, an address in hand beats a status flag.
        const got = canReachForPairing({ onLocalNetwork: true, discovering: false });
        expect(got).toBe(true);
    });
});

describe('unreachableForPairing', () => {
    // Two problems, one symptom. Blaming the other device when this one is not
    // even searching sends the user to the wrong machine.
    it('says this device is not searching when discovery is off', () => {
        const got = unreachableForPairing({ ...base, discovering: false });
        expect(got).toContain('not searching');
    });

    it('says the other device has not appeared when discovery is running', () => {
        expect(unreachableForPairing(base)).toContain('has not appeared');
    });
});
