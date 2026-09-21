# 0018: Sync on the local network by adding a second signaling transport, not a second sync mechanism

- **Status:** Accepted
- **Date:** 2026-09-15
- **Amends:** [0001](0001-mqtt-over-iroh-for-signaling.md), which chose MQTT as
  _the_ signaling transport and left the app unable to sync without an
  internet-reachable broker, and [0009](0009-authenticated-signaling.md), whose
  envelope is now carried by two transports rather than one

## Context

A user with a laptop, a phone and a tablet on the same wifi, and no internet,
cannot sync anything. That is the whole problem, and it is worth being precise
about why, because the obvious reading of it is wrong.

The obvious reading is that sync needs the internet. It does not. When two
paired devices are on the same network, ICE gathers host candidates
(192.168.x.x) and the connectivity check selects that pair over the STUN
reflexive one. Note data already flows directly across the LAN today. The
broker never sees a byte of it, and ADR 0001 said as much.

What the broker actually provides is **rendezvous**: somewhere to leave an
offer, an answer and a handful of ICE candidates for a device whose address you
do not know. Take the internet away and WebRTC is entirely unharmed, but
nothing ever hands `transport.ts` an offer, so no session is ever built.

Three places make this worse than it needs to be by treating the broker as the
definition of "can we sync at all":

- `scheduleReconnect` returns early unless `signalingStatus === 'connected'`
- `reconnectPeer` refuses for the same reason
- `reconnectAllPairedDevices` does too, and is only triggered by `mqtt-status`

So on a network with no route to the broker the app is not degraded, it is
inert, and it stays inert until the broker comes back.

The user-facing requirement that follows from this:

1. Devices on one network sync over that network, with no internet.
2. A device that cannot be reached locally still syncs through the broker.
3. A mix of the two in one household still converges.
4. Local is preferred when both are available.
5. A user can say "local only", and have that mean no broker traffic at all.

## Decision

**1. One data plane. WebRTC stays the only one.** The LAN gets a second way to
_introduce_ two peers, not a second way to move documents. `Framing`,
`DocSyncProtocol`, `DocumentRepository` and every ADR from 0003 onward are
untouched, and there is no second reconciliation path to keep correct.

**2. Discovery is mDNS**, service type `_oyot._tcp.local`, advertising the port
of this device's signaling listener and a TXT record of `nid` (the node_id),
`boot` (the boot id from [ADR 0011](0011-boot-id-for-signaling-sessions.md)) and
`v`.

Deliberately not in the TXT: `display_name` and `user_id`. A café network would
otherwise learn the name of every device the user owns. A paired peer needs only
the node_id to recognise us, and the name already travels inside the
authenticated handshake.

**3. LAN signaling is the same signed envelope over a length-prefixed TCP
frame.** `SignalingMessage` is already transport-agnostic and already carries
its own authentication, because ADR 0009 decided the broker was untrusted
infrastructure. An untrusted LAN is the same threat model, so the envelope
needs no change: 4-byte big-endian length, then the same JSON, on a tokio
listener bound to an ephemeral port.

The listener applies the trust check `handle_offer` already applies (persisted
pair, or session-authorized, or drop), plus a body-size cap and a per-source
rate limit, because anyone on the LAN can connect to it.

**4. One `EnvelopeVerifier` is shared by both transports.** A verifier per
transport would mean a message captured off the broker could be replayed into
the LAN listener inside the 120s skew window, since the nonce history that
would catch it lives in the other instance. Sharing it is an `Arc<Mutex<..>>`
rather than a wire change, so the signing domain stays `oyot-signaling-v1` and
nothing about ADR 0009 is renegotiated.

**5. The route is chosen per peer, and the two are never raced.** LAN when the
peer has been discovered and its LAN route is not in a failure cooldown, broker
otherwise. A LAN attempt that has not reached `connected` in 8 seconds puts
that peer's LAN route into cooldown and the existing backoff retries over the
broker; the 30s negotiation watchdog stays as the outer guard.

Not raced, because two offers for one peer is precisely the collision perfect
negotiation exists to survive, and manufacturing it on every connection to
save a few seconds is a bad trade. One session per peer, keyed by node_id, as
today.

Per peer rather than globally, because the realistic household is a laptop and
a phone on wifi and a tablet on cellular, and that has to converge. It does:
the mesh is pairwise, and ADR 0012 already established that content propagates
through devices that were never the origin.

**6. "Signaling is up" stops meaning "the broker is up".** The three gates
above consult a derived `canSignal`, true when the broker is connected _or_ LAN
discovery is active, and the reconnect sweep is triggered by a peer appearing on
the LAN as well as by `mqtt-status`.

**7. Local-network-only mode does not start the MQTT client.** Not "connects
and ignores it". A setting that promises no internet has to be true at the
packet level or it is a lie the user cannot check.

**8. iOS discovery goes through Bonjour (`NWBrowser`/`NWListener`), not the
Rust mDNS stack.** A pure-Rust implementation binds a raw multicast socket,
which on iOS requires the `com.apple.developer.networking.multicast`
entitlement, which requires an approval request with a turnaround measured in
weeks. `NWBrowser` needs only `NSLocalNetworkUsageDescription` and
`NSBonjourServices`. Waiting on Apple to ship a feature that has a permitted
API is not a trade worth making, so discovery sits behind a trait with a Rust
implementation for desktop and Android and a native one for iOS.

## Alternatives considered

**A second data plane on the LAN: TLS over TCP in Rust, frames bridged to the
webview.** No ICE, no STUN, deterministic, and we already know the peer's
address from discovery. Rejected as the plan: every sync byte would cross the
Tauri IPC boundary, and [ADR 0016](0016-binary-chunks-and-an-anonymous-dev-broker.md)
is the record of what that costs us the last time attachments went through it.
It survives as the documented fallback if the ICE risk below turns out to be
real, in which case it needs its own ADR. Note that discovery and signaling as
decided here are unchanged under that fallback; only the channel changes.

**Run a broker on the LAN.** Mosquitto on one device, or embedded in the app,
announced over mDNS. Tempting because it changes nothing above the transport.
Rejected: it makes one device special, that device has to be awake, and two
phones in a room with no laptop still cannot sync. It also keeps the
rendezvous mechanism heavier than the thing it is doing.

**Tell the user to self-host a broker on their LAN.** Already possible today by
setting the broker URL to a local address. Rejected as the answer: ADR 0001
already names self-hosting friction as a known weakness of the design, and
"install Mosquitto so your phone can sync to your laptop in the same room" is
that weakness at its worst.

**UDP for the signaling messages.** No connection setup, trivially simple.
Rejected: an SDP offer is routinely 2-4KB, so this is a fragmentation and
reassembly problem we would be writing by hand.

**Advertise `display_name` in the TXT record**, so an unpaired device can be
shown by name in a "nearby devices" list. Rejected: it broadcasts the user's
device names to every stranger on every network they join, to save one round
trip on a flow that already requires confirming a node_id by hand.

**Race the LAN and the broker and keep whichever connects.** Fastest in the
common case. Rejected for the collision reason in decision 5.

**A separate signing domain for LAN envelopes**, rather than a shared verifier.
Also closes the cross-transport replay. Rejected: it is a wire format change,
and ADR 0007 means wire format changes are silent breakages between versions.
A shared nonce history costs one mutex.

## Consequences

- Sync works with no internet, which is what "local-first" should have meant
  all along. Pairing does too, once the route abstraction exists, so first-run
  setup on a plane or in a workshop stops being impossible.
- A new dependency, `mdns-sd`, on desktop and Android. The release profile is
  tuned for size (`opt-level = "s"`, for Android's sake), and this pushes
  against that.
- The listener binds a port, so macOS and Windows will show a firewall prompt
  on first run. There is no way to avoid that and still accept connections.
- **The platform cost is not evenly distributed, so this ships in stages.**
  Desktop needs only the Rust path. Android needs a `MulticastLock` held from
  Kotlin (or `NsdManager` instead). iOS needs a native Bonjour plugin. LAN sync
  will exist on desktop before it exists on phones, and the fallback behaviour
  has to be correct throughout, because for a while most pairs will be mixed.
- A device on an older build is not discovered, has no listener, and therefore
  syncs over the broker exactly as it does now. No negotiation and no
  handshake, consistent with ADR 0007, and the degradation is graceful for once.
- A LAN eavesdropper sees node_ids and SDP, which is the same exposure the
  broker already has and ADR 0016 already accepted. Note content stays inside
  WebRTC's DTLS either way.
- **The node_id is stable and now broadcast on every network the device
  joins**, which is a tracking vector that did not exist before: a stranger on
  two different networks can tell it was the same device both times.
  Advertising `SHA256(node_id || hour)` instead would keep recognition working
  for paired peers, who can compute it, while removing that. Not done here;
  worth doing before this is on by default on mobile.
- **The one assumption this rests on is that ICE gives us a usable host
  candidate pair with no internet.** Chromium and WebKit replace host
  candidates with `<uuid>.local` names unless the page holds a media
  permission, and the peer then has to resolve that over mDNS. With no
  reflexive candidate to fall back on, a WebView that cannot resolve it has no
  path at all. This is verified before anything else is built, because if it is
  false the data plane decision flips to the rejected alternative above and
  only the discovery and signaling work survives.
