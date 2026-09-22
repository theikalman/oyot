export interface ReachInputs {
    /** The peer has been found on this network. */
    onLocalNetwork: boolean;
    /** Discovery is running at all, so finding it is still possible. */
    discovering: boolean;
}

/**
 * Whether a pair request to this device can be delivered at all.
 *
 * Pairing used to need only a broker, so the form could send the moment an id
 * was typed. On the local network there is a second condition that did not
 * exist before: the device has to have been found. Discovery takes a moment
 * after an app starts, and a request sent inside that moment failed with a raw
 * "no signaling route to <43 characters>".
 *
 * Since [ADR 0022](../../../docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md)
 * being found is the only condition there is.
 */
export function canReachForPairing(inputs: ReachInputs): boolean {
    return inputs.onLocalNetwork;
}

/**
 * Why it cannot be delivered, in a sentence for the person who asked.
 *
 * Two different problems hide behind one symptom, and they need different
 * answers from the user. Discovery being off is this device's own fault and is
 * usually a firewall prompt; discovery being on and finding nothing is the
 * other device's absence. Saying "not found" for both would send someone to
 * check the wrong machine.
 */
export function unreachableForPairing(inputs: ReachInputs): string {
    if (!inputs.discovering) {
        return 'This device is not searching the network yet, so it cannot reach anything. A firewall prompt may be waiting to be answered.';
    }
    return 'That device has not appeared on this network. Put both devices on the same wifi, with Oyot open on each.';
}
