# 0009: Sign signaling messages, make node_id a public key

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** [0001](0001-mqtt-over-iroh-for-signaling.md), which chose the MQTT
  transport without specifying how a sender is authenticated

## Context

Device identity was a random UUID generated at first launch
(`identity.rs`), and the signaling envelope's `from` field was set by the
publisher and never checked. `handle_offer` resolved trust by looking `msg.from`
up in the `device_pairs` table.

That makes the broker, and anyone who can publish to it, fully trusted. The
attack is one publish:

1. Learn a victim's `node_id` and one of its paired `node_id`s. Both travel in
   cleartext during pairing, on topics any client could subscribe to, and the
   shipped broker was `allow_anonymous true` with no ACLs.
2. Publish an offer to `signaling/<victim>/offer` with `from` set to the paired
   device's id.
3. `handle_offer` finds a matching row, treats it as a trusted reconnect, and
   emits `mqtt-offer-received`. The frontend completes a WebRTC connection and
   runs the full document sync protocol over it.

The result is read and write access to every note. Nothing in the flow verifies
that the sender is who it claims to be, because a UUID carries no proof of
possession: knowing it and owning it are the same thing.

The client also could not use TLS. `mqtt_client.rs` tested
`url.starts_with("mqtt://")`, which does not match `mqtts://`, so a TLS URL fell
through to the bare `host:port` branch and produced the host
`"mqtts://broker.example"`. The failure surfaced as a DNS error naming nothing
relevant.

## Decision

**A device's `node_id` is its Ed25519 public key**, base64url-unpadded: 43
characters, and the alphabet (`A-Za-z0-9-_`) contains no MQTT wildcard or
separator, so it drops into a topic segment unchanged. Knowing an id no longer
implies being able to act as it.

**Every signaling message carries `ts`, `nonce` and `sig`.** The signature
covers a length-prefixed encoding of `from | to | msg_type | payload | nonce`
plus `ts`, under a domain-separation prefix. Length prefixes rather than a
separator: with a separator, a payload containing it could shift the field
boundaries so one signature validates two different readings of the message.

**Verification happens before anything reads the payload**, in the MQTT event
loop:

1. `from` must decode to a valid public key.
2. `ts` must be within 120s of now, in either direction.
3. `sig` must verify against `from`'s key.
4. `(from, nonce)` must not have been seen. The nonce is recorded only after the
   signature verifies, so an unverified sender cannot evict real entries from
   the bounded history.

**The pairing check stays exactly where it was.** Signature verification answers
"is this really that device"; `device_pairs` and `authorized_peers` answer "do we
want to talk to it". Both are required, and conflating them would mean a valid
signature from a stranger got further than it should.

**Publishing goes through one `seal()`**, so there is no code path that emits an
unsigned envelope.

**`mqtts://` and `ssl://` are parsed properly**, defaulting to port 8883, with an
explicit rustls config over the platform root store. An unrecognised scheme is
now an error that names it.

## Alternatives considered

**Broker ACLs and authentication alone.** Much less work, and it is in the
reference `mosquitto.conf` now as defence in depth. But it makes the broker the
security boundary: anyone who runs it, compromises it, or obtains one device's
credentials regains the original attack. The point of an end-to-end sync app is
that the relay does not have to be trusted. Rejected as the primary control,
adopted as a secondary one.

**TLS alone.** Protects the messages in transit and hides pairing traffic from
the network, which is why it is also in this change. It says nothing about a
malicious or compromised broker, which terminates the TLS. Same reason.

**A shared secret established at pairing, with HMAC instead of signatures.**
Cheaper, and adequate for the reconnect path. It cannot cover the pairing
handshake itself, which is precisely where the two devices have no shared state
yet, so the initial exchange would stay unauthenticated. Rejected.

**A compatibility window accepting unsigned messages from older builds.** It
would have to accept exactly the messages this ADR exists to reject, and there
is no way to distinguish "old peer" from "attacker omitting the signature".
Rejected outright; a version that carried this flag would be no safer than
before.

## Consequences

- **Every device must be paired again, once.** Schema v3 clears the keyless
  identity row and every `device_pairs` row, because each one records a peer's
  `node_id` and every `node_id` changed meaning. Documents, attachments and CRDT
  history are untouched. The sync settings page shows a one-time explanation
  rather than leaving the user to discover that sync stopped. Consistent with
  [ADR 0007](0007-drop-protocol-version.md), there is no negotiation: a device
  on an older build simply cannot pair with one on this build.
- **Device IDs are 43 characters instead of 36.** Slightly longer to read aloud,
  still comfortable in a QR code. The pairing field now validates the shape, so
  a typo or a pasted legacy UUID is rejected immediately instead of timing out
  with no explanation.
- **The secret key lives in the app database**, in the app data directory,
  alongside the notes it protects. That is coherent - anything that can read the
  key can already read the notes - but it is weaker than the OS keychain, which
  is the obvious follow-up and is deliberately not in this change: it is
  platform-specific work on four targets and would have held this up.
- **Clock skew over two minutes breaks pairing.** The window has to be finite or
  a captured message could be replayed indefinitely. Two minutes is generous for
  devices that both sync time from the network; a device with a badly wrong
  clock will fail to pair, and the rejection is logged with the reason.
- **Replay history is per client generation.** Reconnecting to the broker starts
  a fresh `EnvelopeVerifier`, so a message captured before a reconnect could be
  replayed once after it, within the 120s window. Closing that would mean
  persisting nonces across restarts, which is a lot of machinery for a replay of
  a message whose effect is at worst a redundant WebRTC offer from a device
  already paired.
- **Nothing authenticates the _pairing_ decision.** A signature proves the
  sender holds a key; it does not prove the human meant to pair with them. The
  user still reads the id off one device and enters it on the other, and still
  confirms the prompt. Out-of-band id exchange is the trust anchor, as before.
