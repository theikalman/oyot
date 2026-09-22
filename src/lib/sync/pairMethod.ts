// How the user says the other device should be reached, and what the form can
// do about it.
//
// There are two ways to reach a device (ADR 0023) and they need different
// things typed. Showing every field at once made the address field look like
// part of pairing rather than an alternative to the network, and left a
// question the form could not answer: whether a blank address meant "it is on
// this network" or "I have not typed it yet".
//
// So the method is a choice, and everything else follows from it. Kept here
// rather than in the component for the reason the other rules in this folder
// are: a decision with cases in it is worth testing without a DOM.

import { nodeIdError } from './nodeId';

export type PairMethod = 'local' | 'address';

export interface PairAttempt {
    method: PairMethod;
    nodeId: string;
    /** Ignored when the method is `local`. */
    address: string;
    /** A request is already out and waiting for an answer. */
    requesting: boolean;
}

/**
 * Whether the Pair button can do anything yet.
 *
 * An address is required when it is the way in, because the whole point of
 * choosing that method is that there is no other route to fall back on. Under
 * `local` it is not asked for and not read.
 */
export function canSubmitPair(attempt: PairAttempt): boolean {
    if (attempt.requesting) return false;
    if (nodeIdError(attempt.nodeId)) return false;
    return attempt.method === 'local' || attempt.address.trim() !== '';
}

/**
 * The address to pair with, which is nothing at all under `local`.
 *
 * A form that keeps what was typed in a field it is no longer showing must not
 * also act on it: switching to "on this network" and pressing Pair would
 * otherwise store an address the user had visibly abandoned.
 */
export function addressFor(attempt: PairAttempt): string {
    return attempt.method === 'address' ? attempt.address.trim() : '';
}

/**
 * What to warn about before anything is sent, or null when there is nothing.
 *
 * Only one case is worth raising early: asking to pair over a network this
 * device is not searching, which cannot work and has a remedy on the same
 * screen. Everything else is only knowable once the request is attempted, and
 * `unreachableForPairing` says it then.
 */
export function pairMethodWarning(method: PairMethod, discovering: boolean): string | null {
    if (method === 'local' && !discovering) {
        return 'This device is not searching the network, so it will not find anything on it. A firewall prompt may be waiting to be answered. If the other device is somewhere else, choose "Somewhere else" and give it an address.';
    }
    return null;
}
