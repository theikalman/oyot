# 0022: Drop the broker entirely; the local network is the only way devices find each other

- **Status:** Accepted, amended by [0023](0023-reach-a-peer-at-an-address-you-already-know.md),
  which adds the stored-address route this ADR deferred
- **Date:** 2026-09-22
- **Supersedes:** [0001](0001-mqtt-over-iroh-for-signaling.md), which chose MQTT
  as the signaling transport
- **Amends:** [0016](0016-binary-chunks-and-an-anonymous-dev-broker.md), whose
  anonymous development broker no longer has anything to carry, and
  [0018](0018-local-network-sync-as-a-second-signaling-transport.md), which made
  the local network the second transport and now makes it the only one

## Context

[ADR 0018](0018-local-network-sync-as-a-second-signaling-transport.md) added
local-network signaling beside the broker and was careful to keep the broker as
the fallback, on the reasoning that a laptop on wifi and a phone on cellular
have to converge. That reasoning still holds. What has changed is the price of
keeping the broker safe, and it is paid by hand, per device, for ever.

[ADR 0009](0009-authenticated-signaling.md) made the envelope signed, so a
broker cannot forge, alter or replay a message. It said plainly that the broker
was untrusted infrastructure. What a signature does not do is stop anyone
reading. Signaling topics are `signaling/<node_id>/<type>`, and on a broker with
no access control every authenticated client can subscribe to `signaling/#` and
watch every pairing and every SDP that crosses it. The envelope is not
encrypted; it does not need to be for the notes to stay private, because the
notes travel inside WebRTC's DTLS, but who is pairing with whom, and when, is
in the clear.

The defence we documented for that is `mosquitto/config/acl.example`, and it is
where the cost lives. Mosquitto cannot bind a topic to the device that owns it,
so the ACL cannot be expressed as a rule. It has to be written out:

```
user phone
topic read signaling/REPLACE-WITH-PHONE-NODE-ID/+
```

One block per device, carrying that device's 43-character node_id, plus one
`mosquitto_passwd` account per device, plus the username and password typed
into Settings > Sync on that device. That is the provisioning work, and none of
it can be automated from inside the app, because the app is a client of a
broker it does not administer. Adding a device means editing a file on a server
and restarting a container before the device can sync at all. Re-keying a
device, which [ADR 0009](0009-authenticated-signaling.md)'s schema v3 migration
already did once to every device in existence, invalidates every one of those
lines at the same time.

So the broker's cost is not the container. It is that a local-first note app
asks its user to run and administer a multi-tenant message bus, correctly, or
accept that anyone else on that bus can watch their devices find each other.
For a single user with three devices, that is the entire security model of the
product resting on a hand-edited text file.

Meanwhile the thing the broker was bought for has already been built. ADR 0018
established that the broker was never in the data path, only the rendezvous,
and the local network now does rendezvous without it: discovery over mDNS, the
same signed envelope over a length-prefixed TCP frame, on desktop and Android.

## Decision

**1. The MQTT client is removed, not disabled.** `network/mqtt_client.rs` is
deleted along with `rumqttc`, `rustls` and `rustls-native-certs`. A broker URL
cannot be configured, because there is nothing to configure it for.
`SignalingMessage` moves to `network/message.rs`, where it is a transport's
payload rather than one transport's type.

**2. There is one route, so there is no route.** `network/route.rs` and its
`choose_route` are deleted. Every signaling message goes over the local network
or fails. The publishing commands no longer return which transport carried a
message, and the inbound events no longer carry a `route` field, because there
is only one answer and reporting it says nothing.

**3. The local-route cooldown goes with it.** `note_lan_failure`,
`clear_lan_failure`, `signaling_note_route_failure`,
`signaling_clear_route_failure` and the frontend's eight-second LAN watchdog all
existed to move a peer onto the broker when the local route stalled. With
nothing to move it to, a cooldown could only have made a working route wait, and
`choose_route` already refused to honour it for exactly that reason.

**4. The sync mode setting is removed.** "Automatic" and "Local network only"
described a choice that no longer exists, and keeping a radio group with one
option is worse than keeping none. `get_sync_mode`/`save_sync_mode` and the
`sync_mode` key in `config.json` go. The stored key is left in place rather than
migrated away; an unknown key in that file has always been ignored.

**5. What replaces the broker for a device that is not on this network is
nothing, and the app says so.** Not a queue, not a "will sync when it can"
that is indistinguishable from a bug. Pairing refuses with a sentence naming the
reason, the paired-devices list shows the peer as offline, and that is the
honest state.

## Alternatives considered

**Keep the broker and make provisioning automatic.** The app would need to
administer the broker: create an account per device, write an ACL block, reload
Mosquitto. That means an admin credential on every device, or a second service
between the app and the broker. Both are strictly more infrastructure than the
thing we are trying to stop needing.

**Keep the broker and encrypt the payload to the recipient.** A sealed box to
the peer's node_id would close the reading hole without any ACL, since node_ids
are already Ed25519 public keys and the peer's key is known at pairing time.
Genuinely attractive, and the right answer if the broker comes back. Rejected
now for scope: it does not remove the broker, so the user still runs one, and
the traffic analysis (who talks to whom, when) survives it. Worth its own ADR if
a remote route is ever reinstated.

**Keep the broker, unauthenticated, and accept that pairings are visible.**
This is what [ADR 0016](0016-binary-chunks-and-an-anonymous-dev-broker.md)'s
development broker already is, and it is fine for development. It is not
something to ship as the default remote path for other people's devices.

**Keep the code and default the setting to local-only.** Cheaper to reverse. It
also keeps `rumqttc`, `rustls` and the TLS trust-store loading in the Android
binary, keeps two routes alive in `signaling_manager`, and keeps every dead
branch in the frontend that the last three months of bugs came out of. Settings
that are off are still surface. If the broker comes back it will come back as a
different design, which is an argument for deleting rather than dimming.

**Reach remote devices over a VPN the user already runs** (Tailscale or
similar), by letting a peer be reached at a fixed address rather than only at a
discovered one. This is the intended successor and is deliberately not in this
ADR. It is a third discovery source feeding the same peer table, not a transport
change, and it needs two things this decision does not: a fixed listening port,
since `lan_signaling` binds an ephemeral one, and an answer to whether the
WebView gathers a usable ICE host candidate on a VPN interface. Both are
unrelated to removing MQTT, and doing them together would mean neither is
reviewable.

## Consequences

- **Two devices that are never on the same network never sync.** This is the
  whole cost and it is a real regression: a phone on cellular and a laptop at
  home used to converge and now do not. [ADR 0012](0012-deletion-propagates-transitively.md)
  softens it in the household case, since content reaches a device through any
  peer it does share a network with, but it does not remove it.
- **iOS has no sync at all, rather than broker-only sync.** ADR 0018 left iOS on
  the broker because `mdns-sd` binds a raw multicast socket that iOS gates
  behind an entitlement. That fallback is now gone, so the `NWBrowser` discovery
  backend stops being a nice-to-have and becomes the thing that makes iOS work.
- **A device on an older build still syncs over the local network**, because the
  LAN path is unchanged on the wire. It will also go on trying to reach its
  broker, and nothing on this build will answer there. Consistent with
  [ADR 0007](0007-drop-protocol-version.md): no negotiation, and the degradation
  is to the older device's own configuration rather than to anything shared.
- **A stored broker URL, username and password stay in `config.json`.** Nothing
  reads them and nothing deletes them. Leaving a password behind on disk after
  the feature that used it was removed is not good, and clearing those three
  keys on first run is worth doing; it is a migration and not this change.
- The release binary loses the whole rustls dependency chain, which the
  `opt-level = "s"` profile exists to care about.
- `docker-compose.yml` and `mosquitto/` are deleted. The development story is
  now two devices on one wifi, which needs no container and is closer to how the
  app is actually used.
- **`canSignal` now means "discovery is running".** It was introduced in ADR
  0018 precisely so that no single transport could define whether the app was
  able to sync, and with one transport left it collapses back to being that
  transport's status. If a second route is ever added, this is the seam it goes
  back into.
