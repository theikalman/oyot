import { describe, it, expect } from 'vitest';
import { syncBadge, type BadgeInputs } from './syncBadge';

const base: BadgeInputs = { peers: 0, phase: 'idle', reachable: false };

describe('syncBadge', () => {
    // The bug this rule was extracted for: a device syncing over the local
    // network was reported as an error because the broker was unreachable.
    // The broker is gone, and a connected peer still decides the badge.
    it('a connected, settled peer reads as synced', () => {
        const got = syncBadge({ peers: 1, phase: 'synced', reachable: true });
        expect(got).toEqual({ tone: 'synced', label: 'Synced' });
    });

    it('a peer mid-transfer reads as syncing', () => {
        const got = syncBadge({ peers: 2, phase: 'transferring', reachable: true });
        expect(got.tone).toBe('syncing');
    });

    it('a peer whose sync failed is the error case', () => {
        const got = syncBadge({ peers: 1, phase: 'error', reachable: true });
        expect(got).toEqual({ tone: 'error', label: 'Sync error' });
    });

    it('nothing connected but discovery running is an empty network, not a fault', () => {
        const got = syncBadge({ ...base, reachable: true });
        expect(got).toEqual({ tone: 'offline', label: 'No devices' });
    });

    it('nothing connected and nothing searching is offline', () => {
        expect(syncBadge(base)).toEqual({ tone: 'offline', label: 'Offline' });
    });
});
