// The wire format for WebRTC signaling payloads, and the rule for deciding
// whether an inbound one is current.
//
// Rust forwards `payload` verbatim, so both ends of this format are frontend
// code and it can change without touching the broker or the Rust side
// (ADR 0002 decision 4).
//
// Split out of transport.ts because it is the part with actual rules in it:
// everything here is pure, so the staleness logic can be tested without an
// RTCPeerConnection or a broker.

// Identifies this run of the app.
//
// `epoch` counts negotiation generations within one process and restarts at 1
// when the app does. `peerEpoch` is a high-water mark, so without a way to tell
// one run from the next, a peer that restarted looked like it was sending
// stale messages: every offer, answer and candidate from its fresh epoch 1 was
// dropped until its counter climbed back past whatever we had recorded, one
// bump per backoff cycle. Reconnect did not help either, because it preserves
// the session and therefore the high-water mark.
//
// A boot id makes the two comparable: a different id means a different
// counter, so the mark is discarded rather than applied across the restart.
export const BOOT_ID = newBootId();

function newBootId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // Only has to distinguish two runs of the same app on one device.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface DescEnvelope {
    /** Absent from a peer running a build that predates boot ids. */
    boot?: string;
    epoch: number;
    description: RTCSessionDescriptionInit;
    /** Resolved by Rust from the pairing, not carried in the payload. */
    roomId?: string;
    displayName?: string;
}

export interface IceEnvelope {
    boot?: string;
    epoch: number;
    candidate: RTCIceCandidateInit;
}

/** What a session remembers about the peer's negotiation generation. */
export interface PeerEpochState {
    peerBoot: string | null;
    peerEpoch: number;
}

export function serializeDesc(epoch: number, description: RTCSessionDescriptionInit): string {
    return JSON.stringify({ boot: BOOT_ID, epoch, description });
}

export function serializeIce(epoch: number, candidate: RTCIceCandidateInit): string {
    return JSON.stringify({ boot: BOOT_ID, epoch, candidate });
}

function readBoot(o: Record<string, unknown>): string | undefined {
    return typeof o.boot === 'string' && o.boot ? o.boot : undefined;
}

export function parseDescPayload(raw: string): {
    boot?: string;
    epoch: number;
    description: RTCSessionDescriptionInit;
} {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.description || typeof o.description !== 'object') {
        throw new Error('unrecognised description payload');
    }
    return {
        boot: readBoot(o),
        epoch: typeof o.epoch === 'number' ? o.epoch : 0,
        description: o.description,
    };
}

export function parseIcePayload(raw: string): {
    boot?: string;
    epoch: number;
    candidate: RTCIceCandidateInit;
} {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !o.candidate || typeof o.candidate !== 'object') {
        throw new Error('unrecognised ICE payload');
    }
    return {
        boot: readBoot(o),
        epoch: typeof o.epoch === 'number' ? o.epoch : 0,
        candidate: o.candidate,
    };
}

/**
 * Decide whether an inbound envelope belongs to the peer's current
 * negotiation, and record what we have now seen from it.
 *
 * Mutates `state`, which is the session's own two fields.
 */
export function admitEnvelope(
    state: PeerEpochState,
    env: { boot?: string; epoch: number },
): 'accept' | 'stale' {
    if (env.boot && env.boot !== state.peerBoot) {
        // A different run of the peer, so its epoch counter has restarted and
        // nothing we remember from the previous run is comparable to it.
        // Discarding the mark here is the whole point of the boot id.
        state.peerBoot = env.boot;
        state.peerEpoch = 0;
    }

    // Epoch 0 means a peer that does not tag its messages at all; there is
    // nothing to compare, so let it through.
    if (env.epoch > 0 && env.epoch < state.peerEpoch) return 'stale';
    if (env.epoch > state.peerEpoch) state.peerEpoch = env.epoch;
    return 'accept';
}
