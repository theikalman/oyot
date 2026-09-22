import { describe, it, expect } from 'vitest';
import { addressFor, canSubmitPair, pairMethodWarning, type PairAttempt } from './pairMethod';

const ID = 'a'.repeat(43);

const base: PairAttempt = {
    method: 'local',
    nodeId: ID,
    address: '',
    requesting: false,
};

describe('canSubmitPair', () => {
    it('needs only an id to pair on this network', () => {
        expect(canSubmitPair(base)).toBe(true);
    });

    // The point of choosing this method is that there is no other route, so a
    // request with nowhere to go is not worth sending.
    it('needs an address as well when that is the way in', () => {
        expect(canSubmitPair({ ...base, method: 'address' })).toBe(false);
        expect(canSubmitPair({ ...base, method: 'address', address: 'laptop.ts.net' })).toBe(true);
    });

    it('refuses an id that is not one, whichever way it is going', () => {
        expect(canSubmitPair({ ...base, nodeId: 'too-short' })).toBe(false);
        expect(
            canSubmitPair({
                ...base,
                method: 'address',
                nodeId: 'too-short',
                address: 'laptop.ts.net',
            }),
        ).toBe(false);
    });

    it('does not send a second request while one is out', () => {
        expect(canSubmitPair({ ...base, requesting: true })).toBe(false);
    });

    it('does not accept whitespace as an address', () => {
        expect(canSubmitPair({ ...base, method: 'address', address: '   ' })).toBe(false);
    });
});

describe('addressFor', () => {
    it('is the typed address when that is the method', () => {
        expect(addressFor({ ...base, method: 'address', address: ' laptop.ts.net ' })).toBe(
            'laptop.ts.net',
        );
    });

    // Switching back to this network and pressing Pair must not store an
    // address the user has visibly abandoned, even though the field kept it.
    it('is nothing on this network, whatever the field still holds', () => {
        expect(addressFor({ ...base, address: 'laptop.ts.net' })).toBe('');
    });
});

describe('pairMethodWarning', () => {
    // The one failure worth raising before anything is sent, because it cannot
    // work and the remedy is on the same screen.
    it('says so when asked to use a network this device is not searching', () => {
        const got = pairMethodWarning('local', false);
        expect(got).toContain('not searching');
        expect(got).toContain('Somewhere else');
    });

    it('says nothing when discovery is running', () => {
        expect(pairMethodWarning('local', true)).toBeNull();
    });

    // An address does not need discovery, so the state of discovery is not a
    // reason to warn anyone about it.
    it('says nothing about an address, searching or not', () => {
        expect(pairMethodWarning('address', false)).toBeNull();
        expect(pairMethodWarning('address', true)).toBeNull();
    });
});
