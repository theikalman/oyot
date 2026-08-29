# 0002: MQTT reconnect and perfect negotiation for peer connections

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

[ADR 0001](0001-mqtt-over-iroh-for-signaling.md) established MQTT (Mosquitto) as
the signaling transport and WebRTC data channels as the sync transport. The first
implementation of that design had no recovery story:

- The MQTT client's event loop exited permanently on the first connection error.
  A dropped broker connection (Wi-Fi bounce, laptop sleep, broker restart) was
  never recovered - the app showed "connected" from a dead client until the user
  reopened the settings page and re-triggered the connection by hand.
- WebRTC connections to already-paired devices were only (re)established by a
  manual "Reconnect" button. Nothing reconnected on app start, on network
  recovery, or after a peer connection dropped.
- Offer/answer handling was asymmetric (`createOfferConnection` vs
  `acceptConnection`) and all connection state was keyed by peer node_id with a
  single slot and no session tag. If both peers sent an offer at nearly the same
  time - which an automatic reconnect sweep on both devices would routinely cause
  - the two negotiations corrupted each other's state and typically no connection
  formed, leaking `RTCPeerConnection` objects.

We wanted reconnection to be automatic and robust enough that the manual button
could be removed, without introducing a race every time both devices try to
reconnect at once.

## Decision

**1. Reconnect the MQTT client in place, with backoff.** The client's poll loop
no longer breaks on error - it sleeps an exponential backoff (1s, doubling, 30s
cap) and continues, letting `rumqttc` re-establish the TCP/MQTT session on the
next poll. Node-scoped topic subscriptions are re-issued on every `ConnAck`
because `rumqttc` does not replay them. A `watch` channel lets the signaling
manager shut down a stale client generation when the broker URL changes or the
user disconnects. `Disconnected` is emitted only on a healthy->broken transition,
and `get_mqtt_status` reports a real tri-state (connected / connecting /
disconnected).

**2. Reconnect paired devices automatically.** A staggered sweep of
not-currently-connected paired devices runs on startup and whenever MQTT
signaling transitions to `connected`. Individual peers get an exponential backoff
(1s -> 30s) on `connectionState` `failed`, on `disconnected` that doesn't
self-heal within a grace period, and on data-channel close. Backoff is paused
while the broker is unreachable (the next signaling-recovery sweep takes over). A
user-initiated disconnect suppresses auto-reconnect for that peer until the app
restarts. The manual "Reconnect" button is removed.

**3. Use WHATWG perfect negotiation for the WebRTC handshake.** A single
symmetric `ensurePeerConnection()` (one `RTCPeerConnection` per peer, driven by
`onnegotiationneeded`) replaces the offer/answer split. Each peer is assigned a
**polite** or **impolite** role deterministically from node_id ordering (the
lexicographically smaller node_id is impolite and wins collisions); the polite
peer rolls back and yields on a collision. Offers and answers are handled by one
code path with the standard `makingOffer` / `ignoreOffer` /
`isSettingRemoteAnswerPending` guards. To keep the steady state glare-free, only
the initiator creates the `yjs-sync` data channel (the impolite peer on a
reconnect sweep, or the pairing initiator on first pair); the polite peer waits
and promotes itself to initiator only if no offer arrives within a timeout.
Perfect negotiation then absorbs the residual races - promotion overlap, ICE
restarts from both sides, a fresh-pairing offer racing a sweep offer.

**4. Tag signaling payloads with an epoch.** Descriptions and ICE candidates now
travel as a JSON envelope `{ epoch, description | candidate }` inside the
existing `SignalingMessage.payload` string (which the Rust side forwards
verbatim, so no protocol change on the broker or in Rust). The epoch is bumped on
every session rebuild, letting a peer drop messages from a superseded
negotiation. Legacy bare-SDP / bare-candidate payloads from older clients are
still accepted (treated as epoch 0).

## Alternatives considered

**Deterministic initiator only (no perfect negotiation).** Pick one side by
node_id to always be the caller; the other never offers. Simpler, and it handles
the reconnect-sweep case. Rejected as the primary mechanism because it does not
cover ICE restarts (either side may need to restart ICE on `failed`) or any
future renegotiation, and it degrades to "no connection" if the designated
caller is the one that is down. We kept the deterministic role *assignment* (it
decides who is polite and who creates the data channel) but layered full perfect
negotiation on top so simultaneous offers are always safe.

**Reconnect the MQTT client by tearing down and recreating it on every error.**
Rejected: `rumqttc`'s event loop already reconnects if you keep polling; a full
teardown per error loses in-flight subscription state and is more code. The
minimal change - don't break, add backoff, re-subscribe on `ConnAck` - is
enough.

**Changing the Rust `SignalingMessage` envelope to carry the epoch.** Rejected as
unnecessary: the Rust side treats `payload` as an opaque string and both ends of
that string are frontend code, so the epoch envelope lives entirely in
TypeScript.

**Keeping the manual "Reconnect" button as a fallback.** Rejected: once the
automatic paths exist, a manual trigger mid-backoff just races
`ensurePeerConnection` against itself. A user who wants a device gone uses
"Remove"; a user who wants to pause syncing uses "Disconnect" (which now
suppresses auto-reconnect).

## Consequences

- The app recovers from broker and peer connection drops on its own. Status in
  the UI reflects the real connection state rather than "a client object
  exists".
- `RECONNECT_BACKOFF_MAX` (30s) means worst-case reconnect latency after a long
  outage is ~30s per peer; acceptable for a background sync feature, and the
  signaling-recovery sweep short-circuits it when the broker itself was the
  problem.
- Perfect negotiation relies on argument-less `setLocalDescription()` and
  implicit rollback, supported by all current system WebViews (WKWebView,
  WebView2, WebKitGTK, Android System WebView). If a target WebView lags, the
  fallback is explicit `createOffer`/`createAnswer` plus a manual
  `{ type: 'rollback' }`.
- During a mixed-version rollout, new clients send the epoch envelope and old
  clients send bare SDP; both are parsed. Once all clients are updated the
  legacy branch is dead code that can be removed.
- TURN is still not configured (STUN only), unchanged from ADR 0001 - ICE
  restart helps recover transient failures but cannot traverse NATs that need a
  relay.
