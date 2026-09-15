import type { BrokerStatus, SyncMode } from '$lib/stores/sync';

export interface ReachInputs {
    /** The peer has been found on this network. */
    onLocalNetwork: boolean;
    /** A broker address is stored, whether or not it is working. */
    brokerConfigured: boolean;
    brokerStatus: BrokerStatus;
    mode: SyncMode;
}

/**
 * Whether a pair request to this device can be delivered at all.
 *
 * Pairing used to need only a broker, so the form could send the moment an id
 * was typed. On the local network there is a second condition that did not
 * exist before: the device has to have been found. Discovery takes a moment
 * after an app starts, and a request sent inside that moment failed with a raw
 * "no signaling route to <43 characters>".
 */
export function canReachForPairing(inputs: ReachInputs): boolean {
    if (inputs.onLocalNetwork) return true;
    if (inputs.mode === 'local-only') return false;
    return inputs.brokerStatus === 'connected';
}

/**
 * Why it cannot be delivered, in a sentence for the person who asked.
 *
 * Every branch names both halves: what the local network did not turn up, and
 * why there is no other way round. Saying only the first would read as "your
 * network is broken" to someone who simply has no broker.
 */
export function unreachableForPairing(inputs: ReachInputs): string {
    const notHere = 'That device has not appeared on this network';
    if (inputs.mode === 'local-only') {
        return `${notHere}. This device is set to local network only, so there is no other way to reach it.`;
    }
    if (!inputs.brokerConfigured) {
        return `${notHere}, and no broker is configured to reach it another way.`;
    }
    if (inputs.brokerStatus === 'connecting') {
        return `${notHere} yet, and the broker is still connecting. Try again in a moment.`;
    }
    return `${notHere}, and the broker is not connected.`;
}
