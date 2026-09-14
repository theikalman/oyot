// The decisions the peer-connection lifecycle makes, separated from the
// machinery that acts on them.
//
// `transport.ts` owns RTCPeerConnection, timers and Tauri events, none of
// which can be exercised in a unit test. These rules can, and they are the
// part that has been wrong before: the epoch comparison in ADR 0004 and the
// missing boot reset in ADR 0011 were both decisions of exactly this kind.

/** Backoff for a peer's first attempt, doubling from here. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Which side yields when both offer at once.
 *
 * Needs no exchange because node_ids are unique and both devices compute the
 * same answer from the same pair: the lexicographically smaller id is the
 * impolite peer and wins the collision. The polite one rolls back.
 *
 * Both sides must agree, so the comparison has to be a total order over the
 * two ids and nothing else. It deliberately does not consult connection
 * state, which the two devices see differently.
 */
export function isPolite(ourNodeId: string, peerNodeId: string): boolean {
    return ourNodeId > peerNodeId;
}

/**
 * How long to wait before attempt number `attempt` (zero-based).
 *
 * Jitter is added by the caller from a random source; it is a parameter here
 * so the shape of the curve can be tested without one. Without jitter, two
 * devices that dropped at the same moment retry in lockstep forever, and
 * every retry is a fresh collision.
 */
export function reconnectDelay(attempt: number, jitterMs = 0): number {
    const exponential = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
    return Math.min(exponential, RECONNECT_MAX_MS) + jitterMs;
}

/** What a sweep knows about one paired device. */
export interface SweepCandidate {
    peerNodeId: string;
    roomId: string;
    /** Whether a data channel to this peer is already up. */
    connected: boolean;
    /** The connection state of an existing session, if there is one. */
    connectionState?: RTCPeerConnectionState;
    /** Whether the user explicitly disconnected this peer. */
    suppressed: boolean;
}

/**
 * Whether a reconnect sweep should try this peer.
 *
 * `connecting` and `connected` are left alone because a sweep that rebuilds a
 * handshake in progress is how two devices end up offering at each other
 * indefinitely. `new` is deliberately not in that list: a connection that
 * never got an answer sits in `new` for ever, and the watchdog needs the
 * sweep to be willing to take it.
 */
export function shouldSweep(candidate: SweepCandidate): boolean {
    if (candidate.connected) return false;
    if (candidate.suppressed) return false;
    const state = candidate.connectionState;
    return state !== 'connecting' && state !== 'connected';
}
