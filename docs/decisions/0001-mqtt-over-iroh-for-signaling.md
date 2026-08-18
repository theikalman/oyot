# 0001: Use MQTT over Iroh's public relay for WebRTC signaling

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

Oyot is a local-first note-taking app that syncs notes peer-to-peer between a
user's own devices using Yjs CRDTs. Peers need two things to sync: a way to
find/reach each other (signaling and NAT traversal) and a data channel to
exchange CRDT updates once connected.

The early prototype used **Iroh**, a Rust P2P networking library that
bundles discovery, hole-punching, and relay fallback in one package. Iroh is
well-engineered and would have removed the need to run any of our own
infrastructure, since it ships with a public relay/discovery service.

That public relay is the problem. Iroh's relay traffic (like Tailscale's and
WireGuard's) uses a protocol signature that is identifiable by Deep Packet
Inspection (DPI). In several countries, including GCC states such as the
UAE, Saudi Arabia, and Qatar, this class of traffic is blocked wholesale at
the network level. We also confirmed this independently in **Oman**: Iroh's
public relay is blocked there too, so a user on that network cannot reach it
to even begin signaling. This isn't a performance degradation or fallback
scenario, it's a hard failure. The app does not connect at all for anyone on
a network that blocks the relay, and we have no ability to fix or work
around it because the relay is infrastructure we don't control.

We need a signaling path that:

1. Does not depend on a single vendor's public relay we cannot swap, patch,
   or route around.
2. Is self-hostable, so we (or advanced users) can run signaling on
   infrastructure of our own choosing if the default becomes blocked in a
   given region.
3. Is simple enough that "self-hosting a signaling endpoint" isn't itself an
   operational burden.

## Decision

Use **WebRTC** for the actual peer-to-peer data channel (it's a browser
standard that ISPs can't block without breaking the web itself), and use a
self-hosted **MQTT** broker (Eclipse Mosquitto) purely as the signaling
transport to exchange WebRTC offers/answers/ICE candidates between devices.

MQTT was chosen for that signaling role specifically because:

- It's a thin, well-understood pub/sub protocol - a natural fit for
  "publish an offer to a topic, the other peer subscribes and responds."
- It's trivially self-hostable on cheap, generic infrastructure (a $5 VPS
  running Mosquitto), so the signaling endpoint is something we (or a
  region-specific deployment) fully control, unlike Iroh's built-in relay.
- Signaling messages are ephemeral, so the broker needs no persistent
  storage and stays operationally simple.
- Because it's just our own server speaking a generic protocol on a port we
  choose, it does not carry the same DPI fingerprint as a purpose-built
  relay/VPN protocol, and if a specific broker or endpoint does get blocked
  in some region, it's just an address to change, not a protocol we're
  locked into.

Once the WebRTC data channel is established, MQTT drops out of the loop
entirely. All note data (Yjs CRDT updates) flows directly peer-to-peer over
WebRTC, not through the broker.

## Alternatives considered

**Iroh (as-is, using its public relay).** Rejected: confirmed blocked in
Oman and known to be blocked in GCC countries generally, due to DPI
fingerprinting of the relay protocol. Since we don't control that relay, we
can't fix the block ourselves.

**Iroh with a self-hosted relay.** Not pursued further: still inherits the
same relay protocol signature that gets DPI-flagged, since the blocking is
on the protocol shape, not the specific server. Self-hosting the relay
doesn't change what the traffic looks like on the wire.

**MQTT as the primary data transport (skip WebRTC entirely).** Rejected:
MQTT is TCP-based and traverses NAT poorly. Using it for the actual sync
data would require a publicly reachable broker for every device, turning a
supposedly P2P app into a centralized bottleneck (and a privacy concern,
since the broker would see all sync traffic, not just a handful of
handshake messages).

## Consequences

- Users (or Oyot's default deployment) must run a Mosquitto broker
  somewhere reachable by all a person's devices. This is a real UX cost for
  a consumer product: self-hosting friction is a known weakness of the
  current design, and a future iteration may embed a lighter signaling
  server directly in the app to remove this step.
- We take on operational ownership of the signaling broker (uptime,
  self-hosting docs, tooling) that we would have gotten for free from
  Iroh's public relay - accepted deliberately, since owning it is what
  makes it possible to work around regional blocks.
- For NAT traversal that STUN can't solve, we still need a TURN relay
  (coturn), which is a separate piece of self-hosted infrastructure. Because
  it forwards generic UDP/TCP rather than a fingerprintable relay protocol,
  it's expected to be much harder to DPI-block than Iroh's relay.
- If MQTT signaling itself is ever blocked in a given region, the fix is
  operational (stand up another broker, change the configured URL) rather
  than architectural, since Oyot doesn't hardcode a single vendor's
  infrastructure.
