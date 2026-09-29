# 0032: Sync over one TLS connection per device pair, not WebRTC

- **Status:** Accepted
- **Date:** 2026-09-28
- **Supersedes:** [0002](0002-signaling-retry-and-perfect-negotiation.md)
  decisions 3 and 4 (perfect negotiation, epochs),
  [0004](0004-manual-reconnect-and-per-direction-epoch.md) decision 2 (the
  per-direction epoch),
  [0016](0016-binary-chunks-and-an-anonymous-dev-broker.md) decisions 4 to 6
  (chunk frames on the data channel),
  [0018](0018-local-network-sync-as-a-second-signaling-transport.md) decision 1
  (WebRTC as the one data plane),
  [0023](0023-reach-a-peer-at-an-address-you-already-know.md) decision 6
  (rewriting ICE candidates)
- **Amends:** [0003](0003-full-document-set-sync.md) decision 6 (framing),
  [0009](0009-authenticated-signaling.md) (pairing leaves the signed envelope
  for TLS, keyed by the same node key),
  [0011](0011-boot-id-for-signaling-sessions.md) (boot ids stay in the advert
  and the probe, and leave the session)
- **Extends:** [0031](0031-move-the-sync-engine-into-rust.md)

## Context

With the engine in Rust ([ADR 0031](0031-move-the-sync-engine-into-rust.md)),
the data channel would be the one piece left in the webview, and it cannot
stay there: a phone's background run has no webview. Rust has no WebRTC of its
own. There are Rust WebRTC stacks, but each would add to both phone builds
either a C++ library built with CMake and OpenSSL, or a young stack whose
phone builds nobody tests.

Most of what WebRTC does is unused here. Two devices can only begin a WebRTC
session after exchanging signaling over TCP, to each other's listener, on this
network or at a stored address (ADR 0023). So any two devices that can sync
can already open a TCP connection to each other. What WebRTC adds is:

- **encryption,** which TLS gives just as well
- **NAT traversal through a public STUN server,** which a route that already
  works does not need

What it costs:

- ICE, perfect negotiation, and epochs and boot ids for sessions
- SCTP's message limits, and the framing that works around them
- candidate rewriting for VPNs (ADR 0023, decision 6)
- a request to Google's STUN server on every connection

It also costs reachability. Every signaling reply, the answer to an offer
included, goes to the other device's own listener, and a device only has a
route to another that mDNS found or a probe answered. So each device needs its
own route to the other, and DEVELOPMENT.md tells users to store an address on
both sides. A phone in the background has no working listener at all, so a
design that has to reach the phone cannot serve a phone's background run
(ADR 0034).

ADR 0018 considered TLS over TCP in Rust and rejected it because every sync
byte would then cross IPC on its way to the webview. Under ADR 0031, sync
bytes no longer go to the webview.

## Decision

**1. One connection per device pair, dialled by whichever device can reach
the other.** A device dials a paired device it has a route to and no
connection with:

- at start
- when discovery or a probe finds the device
- after a wake or a network change (ADR 0030)
- after a drop, on a jittered backoff from one to thirty seconds, as ADR 0002
  decision 2 reconnects today

Only the dialling side needs a route.

A connection counts as up when the other side's first frame arrives, not when
the TLS handshake ends: in TLS 1.3 the dialler finishes its handshake before
the listener has checked its key. When a second connection with the same
device comes up while one exists:

- **The existing one has heard from the device in the last few seconds.** Both
  devices probably dialled at once. The one dialled by the device with the
  lower node_id is kept and the other closed, the same comparison that picks
  today's polite peer, so both sides close the same one.
- **It has not.** It is probably dead: the phone's socket was reclaimed, or
  the laptop slept. The new connection replaces it.

Either way, the manifest exchange starts again on the connection that is
kept.

**2. It is TLS 1.3 with raw public keys, and the key is the node key.** Each
side presents the Ed25519 key its node_id is made from (RFC 7250). rustls
supports this since 0.23.16, and the tree already has 0.23.45 with `ring` for
Drive backups. No certificates, no authorities, nothing to renew.

- **The dialler** checks that the key is the device it meant to reach.
- **The listener** lets a paired device's key through to sync, and an unknown
  key through to pairing only (decision 5). A device the user disconnected is
  refused (decision 10).
- **Every handshake is checked in full.** Session resumption is off on both
  sides, and the key is checked against the pair table after every handshake,
  not only by the verifier. A resumed TLS session skips the verifier, which
  would let a device the user had removed back in.
- **The same key signs signaling envelopes** (ADR 0009). TLS 1.3 signs its
  handshake under its own context string, so neither use can be passed off as
  the other.

**3. It shares the signaling port.** The listener on 19701 reads the first
byte of each connection. A TLS handshake starts with 0x16. A signaling frame's
length is capped at 64 KiB, so its first byte is 0x00. One port means no
second firewall prompt, and no second number in a stored address.

**4. Signed signaling stays, for probing only.** `ping` and `pong` keep their
envelopes and their short connection, a `ping` and its `pong` on one.
`pair-request` and `pair-response` move into TLS (decision 5). `offer`,
`answer` and `ice-candidate` go.

**5. Pairing happens inside TLS, and is decided in Rust.** The requester dials
the device it wants to pair with. The listener lets an unknown key finish the
handshake, but that connection can carry nothing except one pair request. It
closes when the user declines, or does not answer within the pairing timeout.
The pairing prompt's cooldown applies as it does today.

- **Accepting.** Rust keeps the request it raised a prompt for, so accepting
  names only the node_id. The user id and display name come from that
  request, not from the page. The accepting device records the pair when the
  user accepts, and sends `pair-accepted` on the same connection.
- **Being accepted.** The requester records the pair when `pair-accepted`
  arrives, and the connection carries on as that pair's sync connection.
- **The room id** is derived from the two user ids, as today.

The answer goes back on the connection it answers, so pairing needs a route
in one direction only, like syncing. Today the answer goes to the requester's
own listener, so a phone on mobile data could not be answered at all. If the
connection breaks between the two records, one device holds a pairing the
other does not. The device list shows a pairing that has never synced as
such, and removing it or pairing again settles it.

**6. Frames carry a JSON header, then raw bytes.** A frame is a four-byte
length, a JSON header naming the message, and then any bytes the message
carries: a Yjs update, or image data.

- The messages are the ones `protocol.ts` defines, except that image data
  travels in pieces (decision 7).
- Nothing travels as base64 on the wire, and no new serialisation dependency
  is needed.
- Frames are capped at 64 MiB, the largest message today's framing accepts.

**7. Notes go before images.** Image data is sent in pieces of at most 256 KiB,
and a connection sends any waiting document message before the next piece.
The receiver assembles the pieces and stores the image through the checks
`save_attachment_bytes` makes now: the 10 MiB cap, the image type read from
the bytes, and the hash. A background run on a phone may have 30 seconds
(ADR 0034), and a photo must not keep the notes waiting.

**8. A quiet connection is checked, and a dead one dropped.** Each side sends
a heartbeat after 20 seconds with nothing else to send, and drops a connection
that has received no bytes for 60 seconds. Bytes, not frames: a large
document on a slow link can take longer than that to arrive whole. A laptop
that slept, or a phone that was frozen, is noticed within a minute rather than
whenever TCP gives up, which can take many minutes.

**9. Old and new builds do not see each other.** The mDNS advert's version
goes from 1 to 2, and `pong` carries the same number, so a device ignores a
peer that speaks the other protocol instead of failing halfway into a
handshake. This is not negotiation (ADR 0007): nothing adapts, and the two
simply stay apart until both are updated.

**10. "Reconnect" keeps its meaning, and "Disconnect" now lasts.** Reconnect
dials at once, skipping the backoff, and leaves a live connection alone (ADR
0004 decision 1). Disconnect closes the connection and refuses the device
until the user reconnects it. It is stored, so it survives a restart. Today it
lasts until the app restarts, and on a phone a background run often starts a
fresh process, which would forget it.

## Alternatives considered

**WebRTC in Rust.** Each option has a cost here:

- webrtc-rs is in the middle of becoming a thin layer over a new core.
- str0m leaves sockets and interface enumeration to the caller, and nobody
  tests it on phones.
- libdatachannel is a C++ library that needs CMake and OpenSSL in both phone
  builds.

All of them keep ICE, and the need for each side to reach the other.

**Noise over TCP** (the `snow` crate). A good fit on paper. Rejected: `snow`
says it has had no formal audit, and Noise uses X25519 keys, so the Ed25519
node key would need converting or a second key beside it. rustls is already in
the tree.

**QUIC** (`quinn`), as iroh uses with the same raw-key TLS. It brings
multiplexed streams and better behaviour behind NATs. But it is a large new
dependency, and a UDP path that every firewall treats differently, for a route
TCP already covers. Worth revisiting if hole punching is ever wanted.

**Keep WebRTC in the foreground and add TCP for background runs.** The desktop
would have to speak both, forever, and every protocol bug would have two
transports to be reproduced on.

**A separate port for TLS.** Simpler to read, but a second listener, a second
firewall prompt, and a second number for the user to get right in a stored
address.

## Consequences

- Only one device of a pair needs to reach the other. A phone on mobile data
  with Tailscale can sync with a desktop that has no address for the phone,
  and storing an address on both devices (DEVELOPMENT.md) stops being
  necessary.
- A breaking change on the wire, shipped with ADRs 0031 and 0033. A device on
  the old build and one on the new do not see each other until both update
  (decision 9).
- No request goes to Google's STUN server any more, and no private address is
  published in an ICE candidate. `local_address_toward` goes with
  `iceRewrite.ts`.
- Linux no longer depends on WebKitGTK having been built with WebRTC.
- On iOS, reaching a device on the local network needs the Local Network
  permission, as Rust's signaling already does. A VPN address does not.
- Two devices behind separate NATs with no VPN between them cannot sync, even
  where STUN could in principle have joined them. That was never possible in
  practice: signaling needs a direct TCP route before WebRTC can start.
- The listener's rate limit now covers TLS handshakes too, and a handshake
  that has not finished in ten seconds is dropped. An unpaired device can
  complete a handshake, which is what pairing needs, and gets no further than
  a pairing prompt, at the rate the cooldown allows today.
- Before building, a spike checks that two node keys complete this handshake
  between a phone and a desktop.
