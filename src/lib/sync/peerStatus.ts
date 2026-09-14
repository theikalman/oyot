import type { RoomSync } from '$lib/stores/sync';

/** Whether a peer is reachable, and if not, whether we are trying. */
export type PeerConnection = 'connected' | 'connecting' | 'offline';

export function peerConnection(online: boolean, reconnecting: boolean): PeerConnection {
    if (online) return 'connected';
    return reconnecting ? 'connecting' : 'offline';
}

/**
 * What a peer's row should say, in one place.
 *
 * The sidebar and the sync settings page each worked this out from the same
 * three inputs, in different orders, with different wording and a different
 * set of cases covered. So the same peer in the same state could read
 * "Syncing…" in one and "Online" in the other.
 *
 * `compact` is the sidebar, where the row is narrow and a count says more
 * than a word; the settings page has room for a sentence.
 */
export function peerStatusLabel(
    connection: PeerConnection,
    sync: RoomSync | undefined,
    options: { compact?: boolean } = {},
): string {
    if (connection === 'connecting') return 'Connecting…';
    if (connection === 'offline') return 'Offline';

    const compact = options.compact ?? false;
    if (!sync) return compact ? 'Online' : 'Connected';

    switch (sync.phase) {
        case 'reconciling':
            return 'Syncing…';
        case 'transferring':
            if (sync.total <= 0) return 'Syncing…';
            return compact
                ? `${sync.total - sync.pending}/${sync.total}`
                : `Syncing ${sync.total - sync.pending}/${sync.total}…`;
        case 'error':
            return compact ? 'Error' : 'Sync error · retrying';
        default:
            return compact ? 'Online' : 'Connected';
    }
}
