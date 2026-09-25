import type { RoomSyncPhase } from '$lib/stores/sync';

/** What the badge is saying, which decides its colour. */
export type SyncTone = 'synced' | 'syncing' | 'offline' | 'error';

/**
 * The colour of the badge's dot for each tone. Here rather than in the badge,
 * so the help page's key to the colours uses the same ones.
 */
export const SYNC_TONE_COLORS: Record<SyncTone, string> = {
    synced: 'var(--status-synced, #22c55e)',
    syncing: 'var(--status-syncing, #eab308)',
    error: 'var(--status-error, #ef4444)',
    offline: 'var(--status-offline, #9ca3af)',
};

export interface BadgeInputs {
    /** How many peers are connected right now. */
    peers: number;
    /** Worst-case document-sync phase across those peers. */
    phase: RoomSyncPhase;
    /** Whether anything at all can carry signaling, i.e. discovery is up. */
    reachable: boolean;
}

/**
 * The state of sync, in one word and one tone.
 *
 * A rule of its own for the reason `peerStatus.ts` is: this is worked out from
 * several inputs whose relationship is not obvious, and it was wrong. The
 * broker's own state was tested first, which made "the broker is unreachable"
 * and "sync is broken" the same red badge. They stopped being the same thing
 * when the local network became a route of its own, and a device syncing
 * perfectly over wifi with no broker in reach was reported as an error, beside
 * the count of the devices it was happily syncing with.
 *
 * A connected device decides the badge. With nothing connected, the question is
 * only whether this device can still reach anything: it can, and the network is
 * simply empty, or it cannot, and it is offline. ADR 0022 removed the broker
 * and with it the last input that could put this in an error state on its own.
 */
export function syncBadge(inputs: BadgeInputs): { tone: SyncTone; label: string } {
    const { peers, phase, reachable } = inputs;

    if (peers > 0) {
        if (phase === 'error') return { tone: 'error', label: 'Sync error' };
        if (phase === 'synced') return { tone: 'synced', label: 'Synced' };
        return { tone: 'syncing', label: 'Syncing…' };
    }

    // Nothing connected. Something can still carry a pairing or a reconnect,
    // so this is an empty network rather than a fault.
    if (reachable) return { tone: 'offline', label: 'No devices' };

    return { tone: 'offline', label: 'Offline' };
}
