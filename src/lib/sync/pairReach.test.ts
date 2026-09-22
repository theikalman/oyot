import { describe, it, expect } from 'vitest';
import { canReachForPairing, unreachableForPairing, type ReachInputs } from './pairReach';

const base: ReachInputs = {
    onLocalNetwork: false,
    discovering: true,
    onStoredAddress: false,
    hasStoredAddress: false,
};

describe('canReachForPairing', () => {
    it('a device found on this network can be paired with', () => {
        expect(canReachForPairing({ ...base, onLocalNetwork: true })).toBe(true);
    });

    // ADR 0023: pairing over a stored address is the point of storing one, and
    // it has to work before the pairing exists.
    it('a device whose stored address answered can be paired with', () => {
        expect(canReachForPairing({ ...base, onStoredAddress: true })).toBe(true);
    });

    // An address is a guess until something answers it. Letting the request go
    // out on the strength of a row in a table is how "Requesting..." hangs.
    it('an address that has not answered is not a way to reach anything', () => {
        expect(canReachForPairing({ ...base, hasStoredAddress: true })).toBe(false);
    });

    // The reported failure: the other device not yet found, and nothing else.
    it('a device that has not been found cannot be paired with', () => {
        expect(canReachForPairing(base)).toBe(false);
    });

    it('being found is enough even while discovery is reported off', () => {
        // The peer table is only populated by discovery, so this combination
        // should not arise; if it does, an address in hand beats a status flag.
        const got = canReachForPairing({ ...base, onLocalNetwork: true, discovering: false });
        expect(got).toBe(true);
    });
});

describe('unreachableForPairing', () => {
    // Three problems, one symptom. Blaming the other device when this one is
    // not even searching sends the user to the wrong machine.
    it('says this device is not searching when discovery is off', () => {
        const got = unreachableForPairing({ ...base, discovering: false });
        expect(got).toContain('not searching');
    });

    it('says the other device has not appeared when discovery is running', () => {
        expect(unreachableForPairing(base)).toContain('has not appeared');
    });

    // Telling someone who has typed a tailnet address to get on the same wifi
    // is advice for a setup they are deliberately not using.
    it('blames the address when there is one and it is not answering', () => {
        const got = unreachableForPairing({ ...base, hasStoredAddress: true });
        expect(got).toContain('not answering');
        expect(got).not.toContain('same wifi');
    });
});
