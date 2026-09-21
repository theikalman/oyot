import type { BrokerStatus, RoomSyncPhase } from '$lib/stores/sync';

/** What the badge is saying, which decides its colour. */
export type SyncTone = 'synced' | 'syncing' | 'offline' | 'error';

export interface BadgeInputs {
    /** How many peers are connected right now. */
    peers: number;
    /** Worst-case document-sync phase across those peers. */
    phase: RoomSyncPhase;
    broker: BrokerStatus;
    /** Whether anything at all can carry signaling: the broker, or this network. */
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
 * A connected device decides the badge. The broker only decides it when
 * nothing is connected and there is no other way to reach anything, where
 * "cannot reach the broker" really is the whole story.
 */
export function syncBadge(inputs: BadgeInputs): { tone: SyncTone; label: string } {
    const { peers, phase, broker, reachable } = inputs;

    if (peers > 0) {
        if (phase === 'error') return { tone: 'error', label: 'Sync error' };
        if (phase === 'synced') return { tone: 'synced', label: 'Synced' };
        return { tone: 'syncing', label: 'Syncing…' };
    }

    // Nothing connected. Something can still carry a pairing or a reconnect,
    // so this is an empty network rather than a fault.
    if (reachable) return { tone: 'offline', label: 'No devices' };

    if (broker === 'connecting') return { tone: 'offline', label: 'Connecting…' };
    if (broker === 'error') return { tone: 'error', label: 'Sync error' };
    return { tone: 'offline', label: 'Offline' };
}
