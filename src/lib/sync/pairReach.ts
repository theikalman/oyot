export interface ReachInputs {
    /** The peer has been found on this network. */
    onLocalNetwork: boolean;
    /** Discovery is running at all, so finding it is still possible. */
    discovering: boolean;
    /** An address stored for the peer has answered a probe (ADR 0023). */
    onStoredAddress: boolean;
    /** An address is stored for it, whether or not it has ever answered. */
    hasStoredAddress: boolean;
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
 * [ADR 0022](../../../docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md)
 * made being found the only condition there was.
 * [ADR 0023](../../../docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md)
 * adds the second way of being found, and it is the same condition either way:
 * something has answered.
 */
export function canReachForPairing(inputs: ReachInputs): boolean {
    return inputs.onLocalNetwork || inputs.onStoredAddress;
}

/**
 * Why it cannot be delivered, in a sentence for the person who asked.
 *
 * Three different problems hide behind one symptom, and they need different
 * answers from the user. An address that has never answered is the other
 * device being off, or the address being wrong, and saying "put both devices
 * on the same wifi" to someone who has just typed a tailnet name would be
 * advice for a setup they are not using. Discovery being off is this device's
 * own fault and is usually a firewall prompt; discovery being on and finding
 * nothing is the other device's absence.
 */
export function unreachableForPairing(inputs: ReachInputs): string {
    if (inputs.hasStoredAddress) {
        return 'The address stored for that device is not answering. Check that the other device is awake with Oyot open, and that the address is right.';
    }
    if (!inputs.discovering) {
        return 'This device is not searching the network yet, so it cannot reach anything. A firewall prompt may be waiting to be answered, or you can add an address for the other device.';
    }
    return 'That device has not appeared on this network. Put both devices on the same wifi with Oyot open on each, or add an address for it.';
}
