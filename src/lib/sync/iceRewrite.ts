// Making a host ICE candidate usable by a peer that is not on this network.
//
// Chromium-family WebViews replace the address in a host candidate with an
// `<uuid>.local` mDNS name unless a media permission has been granted, so that
// a web page cannot learn the addresses of the machine it is running on. Within
// one broadcast domain the peer resolves that name and the candidate works,
// which is why the local route has never had to care about it.
//
// A VPN carries no multicast. The name resolves to nothing, the candidate is
// dead on arrival, and the connection silently never forms - the failure this
// module exists to prevent. The socket behind the candidate is real and its
// port is in the string in clear, so naming the address it is reachable at is
// all that is missing, and Rust can work out which of this device's addresses
// the peer would be reached from.
//
// See docs/decisions/0023-reach-a-peer-at-an-address-you-already-know.md.

/** Whether this candidate names an address the peer will not be able to use. */
export function isObfuscated(candidate: string): boolean {
    return connectionAddress(candidate)?.endsWith('.local') ?? false;
}

/**
 * The same candidate with its `.local` name replaced by `address`.
 *
 * Returns null when there is nothing to do: a candidate that already names an
 * address, or one this does not recognise. Leaving it alone is right in both
 * cases, because the original is published either way and a candidate we
 * mangled would be worse than one we ignored.
 *
 * The foundation is changed too. Two candidates sharing a foundation are
 * treated as the same base by ICE, and these are deliberately different bases:
 * the same name, resolved differently.
 */
export function rewriteCandidate(
    init: RTCIceCandidateInit,
    address: string,
): RTCIceCandidateInit | null {
    const candidate = init.candidate;
    if (!candidate || !address) return null;

    const prefix = candidate.startsWith('candidate:') ? 'candidate:' : '';
    const parts = candidate.slice(prefix.length).split(' ');
    // foundation, component, transport, priority, address, port, "typ", type
    if (parts.length < 8 || parts[6] !== 'typ') return null;
    if (!parts[4].endsWith('.local')) return null;

    parts[0] = `${parts[0]}1`;
    parts[4] = address;

    return { ...init, candidate: prefix + parts.join(' ') };
}

function connectionAddress(candidate: string): string | null {
    const prefix = candidate.startsWith('candidate:') ? 'candidate:' : '';
    const parts = candidate.slice(prefix.length).split(' ');
    if (parts.length < 8 || parts[6] !== 'typ') return null;
    return parts[4];
}
