import { describe, it, expect } from 'vitest';
import { peerConnection, peerStatusLabel } from './peerStatus';
import type { RoomSync } from '$lib/stores/sync';

const sync = (over: Partial<RoomSync> = {}): RoomSync => ({
    phase: 'synced',
    pending: 0,
    total: 0,
    lastSyncedAt: null,
    ...over,
});

describe('peerConnection', () => {
    it('prefers connected over connecting', () => {
        expect(peerConnection(true, true)).toBe('connected');
        expect(peerConnection(false, true)).toBe('connecting');
        expect(peerConnection(false, false)).toBe('offline');
    });
});

describe('peerStatusLabel', () => {
    it('reports an unreachable peer the same either way', () => {
        for (const compact of [true, false]) {
            expect(peerStatusLabel('offline', undefined, { compact })).toBe('Offline');
            expect(peerStatusLabel('connecting', undefined, { compact })).toBe('Connecting…');
        }
    });

    it('ignores the sync phase when the peer is not connected', () => {
        // The phase is stale once a peer drops, so reporting it would say
        // "Syncing…" about a device that is not there.
        expect(peerStatusLabel('offline', sync({ phase: 'transferring', total: 5 }))).toBe(
            'Offline',
        );
    });

    it('counts documents while transferring', () => {
        const s = sync({ phase: 'transferring', pending: 2, total: 5 });
        expect(peerStatusLabel('connected', s, { compact: true })).toBe('3/5');
        expect(peerStatusLabel('connected', s)).toBe('Syncing 3/5…');
    });

    it('does not show a count it does not have', () => {
        const s = sync({ phase: 'transferring', pending: 0, total: 0 });
        expect(peerStatusLabel('connected', s, { compact: true })).toBe('Syncing…');
    });

    it('says the same thing in both places for every phase', () => {
        // Not identical wording, but never contradictory: the two views
        // previously disagreed about whether a peer was syncing or idle.
        for (const phase of ['reconciling', 'transferring', 'synced', 'error', 'idle'] as const) {
            const compact = peerStatusLabel('connected', sync({ phase }), { compact: true });
            const full = peerStatusLabel('connected', sync({ phase }));
            const isProblem = (s: string) => s.toLowerCase().includes('error');
            const isBusy = (s: string) => s.toLowerCase().includes('sync') && !isProblem(s);
            expect(isProblem(compact)).toBe(isProblem(full));
            expect(isBusy(compact)).toBe(isBusy(full));
        }
    });
});
