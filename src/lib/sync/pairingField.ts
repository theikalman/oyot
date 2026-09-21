import type { PairingState } from '$lib/stores/sync';

/**
 * Whether the pair form should empty its Node ID field.
 *
 * A rule of its own rather than a condition inside the effect that acts on it,
 * because the condition was wrong in a way nothing could catch. It read
 * `pairingState === null`, which is also the state before anything has been
 * attempted, so the effect re-ran on the first character typed and erased it:
 * the field could not hold anything at all, by hand or from a QR scan, and
 * pairing from that form was impossible. Every type check, lint and test
 * passed throughout.
 *
 * Clearing happens when a request is answered and accepted, and only then.
 * Not when it is sent: a request that is declined or never answered leaves the
 * id in place to retry with, rather than 43 characters to find again.
 */
export function clearsPairField(previous: PairingState, next: PairingState): boolean {
    return previous === 'requesting' && next === null;
}
