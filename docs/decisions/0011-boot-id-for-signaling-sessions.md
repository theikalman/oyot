# 0011: Identify a signaling session by boot id, not epoch alone

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0004](0004-manual-reconnect-and-per-direction-epoch.md)
  (decision 2, per-direction epoch tracking)

## Context

ADR 0004 fixed a real bug by tracking the epoch per direction: `peerEpoch` is
the highest epoch seen _from_ a peer, and an incoming message is stale only if
it goes backwards relative to that, rather than relative to our own counter.

The fix is correct within one run of the peer, and wrong across a restart.
`epoch` is a per-process counter starting at 1, `peerEpoch` is a high-water
mark, and nothing ever lowered it. So:

1. A flaky afternoon leaves our `peerEpoch` for the phone at, say, 12.
2. The phone app is killed and relaunched. Its counter starts again at 1.
3. Every offer, answer and ICE candidate it sends is dropped as stale.

The phone is unreachable until its own counter climbs back past 12, which takes
one bump per backoff cycle, capped at 30s each. Reconnect does not help:
`reconnectPeer` goes through `ensurePeerConnection` with the session present,
which carries `peerEpoch` forward by design. Only Disconnect followed by
Reconnect clears it, because that tears the session down.

ADR 0004 considered asymmetric _rates_ of rebuilding but not a counter that
restarts, which is the one case a high-water mark cannot express.

## Decision

**Signaling payloads carry a per-process `boot` id**, generated once at
startup. On receipt, a boot id different from the one recorded for that peer
means a different run and therefore a different counter, so `peerEpoch` is
reset to 0 before the staleness check. Within one run the check is unchanged.

The field is optional on the wire. A peer that omits it behaves exactly as it
did before, so this is additive rather than a format change.

**The envelope format and the staleness rule move to
`sync/signaling/envelope.ts`.** They are the part of the transport with actual
rules in them and they are pure, so they can be tested without an
`RTCPeerConnection` or a broker. `transport.ts` had no tests at all, and this
rule had already been wrong twice.

**The legacy bare-SDP and bare-candidate parsing is removed.** ADR 0002 kept it
for a mixed-version rollout. [ADR 0009](0009-authenticated-signaling.md) made
`node_id` a public key and cleared every pairing, so both devices must be on a
build with the tagged envelope to pair at all, and the branch is unreachable.

## Alternatives considered

**Reset `peerEpoch` when the local connection reaches `failed` or `closed`.**
No wire change, and it covers the common case where we notice the peer going
away. Rejected: we often do not notice. A peer that restarts quickly, or that
was already unreachable when it restarted, never moves our connection into
either state, and those are exactly the cases where the peer is trying to reach
us.

**Make the epoch a timestamp instead of a counter.** Monotonic across restarts,
no extra field. Rejected: it makes correctness depend on the device clock,
which ADR 0003 and ADR 0008 already note is the weakest thing in the system,
and a clock that steps backwards would reintroduce the same bug with no way to
detect it.

**Drop the epoch check entirely and rely on perfect negotiation.** ADR 0004
rejected this on the grounds that a stale offer still causes needless rollback
churn. That reasoning holds, and a boot id is cheaper than the churn.

**Have the peer reset our epoch for us by signalling a restart explicitly.** A
"hello, I restarted" message. Rejected: that is a handshake, and
[ADR 0007](0007-drop-protocol-version.md) removed the last one for good
reasons. A field on the messages already being sent needs no round trip and
cannot be missed.

## Consequences

- A restarted device reconnects at the next sweep or backoff tick instead of
  after several minutes of its messages being discarded.
- One more small field on every signaling message.
- A mixed pair, one device updated and one not, works as it does today: the
  older device sends no boot id, so nothing resets and both fall back to ADR
  0004's behaviour. No negotiation, consistent with ADR 0007.
- `transport.ts` gets its first tests, for the rule that has now been the
  subject of two ADRs. The rest of the module remains untested; splitting it
  further is separate work.
