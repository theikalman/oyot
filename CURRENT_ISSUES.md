# Issues

- ~~Unstable online/offline status when opening settings page. Probably because we only
  trigger mqtt connection when we open the settings page.~~ RESOLVED - the MQTT client now
  auto-reconnects with backoff, `get_mqtt_status` reports a real tri-state, and the UI
  status is driven by the `mqtt-status` event stream instead of an optimistic guess. See
  [ADR 0002](docs/decisions/0002-signaling-retry-and-perfect-negotiation.md).
- I wanted the pair method to be paired with QR/input manual code instead of listing
  all available devices and do "connection" unsafely. The current implementation will list
  out all of the available devices connected to the same mqtt server.
- Add "Connected Devices" (peer to peer) section in left navbar, and have a "signal" whether
  the devices is online or not.




## How current implementation of pairing works

Architecture

WebRTC data channels carry the real Yjs CRDT sync traffic; MQTT only relays the offer/answer/ICE handshake needed to set up that WebRTC connection (documented in docs/decisions/0001-mqtt-over-iroh-for-signaling.md — they moved off Iroh's public relay because it's DPI-blocked in some countries, and self-host Mosquitto instead).

Flow

1. Identity: each device generates a random user_id and node_id (UUIDv4) on first run, stored in SQLite (identity.rs).
2. Connect to broker: MqttSignalingClient (rumqttc) connects using the node_id as the MQTT client ID. No username/password/TLS — plain unauthenticated TCP.
3. Presence/discovery: on connect, a device publishes peer-joined to the shared topic signaling/online. Every device on the same broker sees every other device — this isn't scoped per-user, so any two clients pointed at the same broker discover each other automatically, without needing to exchange the Node ID/QR code first.
4. Pairing: user clicks "Connect" on a discovered peer → creates an RTCPeerConnection (STUN only: stun:stun.l.google.com:19302, no TURN despite the ADR mentioning coturn) → publishes an SDP offer to signaling/{peer_node_id}/offer. The other side answers via signaling/{peer_node_id}/answer, then both sides trickle ICE candidates over signaling/{peer}/ice-candidate.
5. A room_id is derived as SHA256(sorted([user_id_a, user_id_b]))[:16 bytes hex] — computed independently on both sides and used as a local pairing key (persisted in the device_pairs SQLite table), not an MQTT topic.
6. Once the RTCPeerConnection reaches connected, MQTT is no longer needed for that pair; ongoing sync happens over the WebRTC data channel (yjs-sync).

Notable gaps

- No broker auth/TLS: allow_anonymous true, plain 1883. Anyone reaching the broker sees all presence/offer/answer/ICE traffic in cleartext and can publish forged signaling messages (no signing on the SignalingMessage envelope).
- Wildcard subscriptions: clients subscribe to signaling/+/offer etc. rather than a node-scoped topic, so everyone receives everyone's signaling traffic; addressing is enforced only client-side via the to field. Commit 5dfc495 fixed a bug where a device processed its own echoed-back offer as if from a peer.
- Likely lingering room_id mismatch bug: the frontend computes room_id from user_id+user_id, but the Rust side (signaling_manager.rs handling an inbound offer) computes it from user_id+msg.from — and msg.from is actually the sender's node_id, not user_id. Unless node_id == user_id, the accepting device's room_id won't match the initiator's, which could explain lingering "paired but shows offline" symptoms even after 22f289d.
- Discovery bypasses the QR/Node-ID sharing UI: since presence is broadcast to the whole broker, the "share this Node ID" flow (NodeIdCard.svelte QR code) isn't actually required to pair — any two devices on the broker just see each other.
- No E2E encryption negotiated during pairing — security relies entirely on WebRTC's built-in DTLS once the data channel is up; the signaling itself is unauthenticated and unencrypted.





### Considerations

Do you want the broker-hardening items (auth/TLS on Mosquitto) included in this task, or tracked separately?

❯ 1. Separate follow-up (Recommended)
     This plan focuses on the app-level pairing protocol change. Broker auth/TLS is infrastructure/deployment config, best done as its own task once the protocol is settled.
  2. Include in this task
     Add Mosquitto username/password or TLS config now, alongside the code changes.
  3. Type something.

