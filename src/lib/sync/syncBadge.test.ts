import { describe, it, expect } from 'vitest';
import { syncBadge, type BadgeInputs } from './syncBadge';

const base: BadgeInputs = { peers: 0, phase: 'idle', broker: 'disconnected', reachable: false };

describe('syncBadge', () => {
    // The bug: a device syncing over the local network, with the broker
    // unreachable, was reported as a sync error next to the device count.
    it('a peer syncing locally is not an error just because the broker is down', () => {
        const got = syncBadge({
            ...base,
            peers: 1,
            phase: 'synced',
            broker: 'error',
            reachable: true,
        });
        expect(got).toEqual({ tone: 'synced', label: 'Synced' });
    });

    it('a peer whose sync actually failed is an error', () => {
        const got = syncBadge({
            ...base,
            peers: 1,
            phase: 'error',
            broker: 'connected',
            reachable: true,
        });
        expect(got.tone).toBe('error');
    });

    it('a peer still reconciling is syncing', () => {
        const got = syncBadge({
            ...base,
            peers: 2,
            phase: 'transferring',
            broker: 'connected',
            reachable: true,
        });
        expect(got).toEqual({ tone: 'syncing', label: 'Syncing…' });
    });

    // Nothing found on a network that is working is not a fault.
    it('no peers on a reachable network is not an error', () => {
        const got = syncBadge({ ...base, broker: 'error', reachable: true });
        expect(got).toEqual({ tone: 'offline', label: 'No devices' });
    });

    it('an unreachable broker with no other route is an error', () => {
        const got = syncBadge({ ...base, broker: 'error', reachable: false });
        expect(got).toEqual({ tone: 'error', label: 'Sync error' });
    });

    it('a broker still connecting says so', () => {
        const got = syncBadge({ ...base, broker: 'connecting', reachable: false });
        expect(got).toEqual({ tone: 'offline', label: 'Connecting…' });
    });

    it('nothing configured and nothing reachable is offline', () => {
        expect(syncBadge(base)).toEqual({ tone: 'offline', label: 'Offline' });
    });
});
