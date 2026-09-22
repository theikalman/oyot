# 0023: Reach a peer at an address you already know, over a VPN the user already runs

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amends:** [0022](0022-drop-the-broker-and-sync-only-on-the-local-network.md),
  whose fifth decision was that a device not on this network is unreachable and
  the app says so, and whose closing consequence left `canSignal` collapsed onto
  mDNS being up. This is the successor route that ADR deferred.

## Context

[ADR 0022](0022-drop-the-broker-and-sync-only-on-the-local-network.md) removed
the broker and was explicit about the price: two devices that are never on the
same network never sync. It also named the intended successor and the two
things that successor needed, neither of which belonged in the change that
removed MQTT. They are the whole of this ADR:

- **A fixed listening port.** `lan_signaling` binds `0.0.0.0:0` and mDNS
  advertises whatever it got. A peer that cannot hear an mDNS advertisement has
  no way to learn an ephemeral port.
- **An answer to whether the WebView gathers a usable ICE candidate on a VPN
  interface.** Tailscale does not carry multicast, so nothing about the local
  route transfers for free.

The thing worth being precise about is what is actually missing. It is not a
transport: the length-prefixed TCP frame in `lan_signaling` works over any path
that carries TCP, and a tailnet carries TCP. It is not trust either, because
[ADR 0009](0009-authenticated-signaling.md) made every envelope signed and
treated the transport as untrusted infrastructure, so a message that arrives
over a VPN is admitted or rejected on exactly the evidence a message arriving
over wifi is. What is missing is one fact: **where to send it.** mDNS is the
only thing that has ever supplied that fact, and it only works within a
broadcast domain.

## Decision

**1. A peer can be reached at an address the user gives it, and Tailscale is
how we recommend having one.** The stored thing is a host and a port, nothing
more. A MagicDNS name, a `100.x` tailnet address, a LAN address that does not
move, a WireGuard peer: the code cannot tell them apart and does not try.
Oyot does not link against Tailscale, shell out to it, read `tailscaled`'s
LocalAPI, or know whether it is installed. Naming the feature after a product
we do not integrate with would be a lie about the dependency, and a
Tailscale-shaped API would be an integration we would then have to keep working
on four platforms.

**2. It is a third source feeding one peer table, not a second transport.** The
table, its TTL sweep and its found/lost events move out of `lan_discovery` into
`network/peers.rs`, and an entry gains a `source`. mDNS writes entries with
source `mdns`; the endpoint prober writes entries with source `address`.
`SignalingManager` asks the table where a peer is and prefers the local entry
when there are two, because a peer on this wifi should not have its signaling
routed through a VPN to come back to the same room.

**3. The listener takes a fixed port, and says so when it could not.** It tries
19701 and falls back to an ephemeral port. mDNS still advertises whatever was
actually bound, so the local route is unaffected either way, and a device that
lost the fixed port is inbound-unreachable over a stored address. That is a
real state with a real cause (another copy of the app, or something else on the
port) and the settings screen reports it rather than looking healthy.

**4. Reachability over a stored address is proved, not assumed, by a signed
`ping` that gets a signed `pong` back on the same connection.** An address in
the database is a guess: the device may be off, the tailnet may be down, the
name may have been mistyped. mDNS supplies found and lost events, and every
reconnect path, the pairing form and the device list are built on having them,
so an address route has to supply them too. A TCP connect alone would prove
only that something is listening, so the probe is a real signed message and the
reply is verified like any other: right recipient, valid signature, fresh,
not replayed.

This is the first message in the protocol with a reply on its own connection.
`Inbound::receive` returns an optional message for the listener to write back,
and every existing type still returns `None`, so the one-message-per-connection
shape ADR 0018 chose is intact for everything else.

**5. Addresses are typed in, once, per device.** There is no discovery of
tailnet peers and no address exchange between devices yet. Typing a host is the
only mechanism that works on every platform we ship, including Android, where
no other app's Tailscale state is reachable, and it matches a pairing flow whose
first step is already reading a 43-character id off another screen. An
automatic exchange of endpoints over the authenticated channel, so that pairing
once on wifi is enough, is the obvious next step and is deliberately not in
this change.

**6. Obfuscated ICE candidates are rewritten onto this device's own addresses
before they are published to a peer that is not on this network.** This is the
answer to ADR 0022's second question and it is the part that would otherwise
silently not work. Chromium-family WebViews replace host candidates with an
`<uuid>.local` mDNS name unless a media permission has been granted. Within a
broadcast domain the peer resolves that name and the candidate works, which is
why the local route has never had to care. A tailnet carries no multicast, so
the name resolves to nothing and the candidate is dead on arrival.

The socket behind such a candidate is real and its port is in the candidate
string in clear. So Rust enumerates this device's own non-loopback interface
addresses, and for each obfuscated candidate the frontend publishes additional
copies with the `.local` name replaced by each of them, keeping the port. At
most one copy names the interface that socket is actually bound to; ICE's
connectivity checks discard the rest, which is what they are for. The original
`.local` copy is still published, so a peer that can resolve it is unaffected.

This runs only for a peer that is not in the table under source `mdns`, so the
local route publishes exactly what it publishes today.

## Alternatives considered

**Read the tailnet from `tailscaled`.** `tailscale status --json`, or the
LocalAPI over its unix socket, would list the user's devices with their
addresses and remove the typing. It is desktop-only: the Android and iOS
Tailscale apps expose nothing to another app, and Android is precisely where
this feature is worth the most. The socket path and its authentication differ
per platform and per install method, the sandboxed macOS build needs a port and
token read out of a `sameuserproof` file, and after all of that it still cannot
say which tailnet host runs which Oyot node_id, so a probe would be needed
anyway. It buys convenience on half the platforms for a dependency on all of
them.

**Turn off mDNS candidate obfuscation instead of rewriting.** WebView2 accepts
`--disable-features=WebRtcHideLocalIpsWithMdns` through Tauri's additional
browser arguments. Android WebView and WKWebView have no equivalent, so it
would fix one platform out of four and leave the rewrite needed anyway for the
others.

**Drop WebRTC on the remote route and carry the data channel over the Rust TCP
connection.** Tailscale is already authenticated, encrypted and NAT-traversing,
so ICE and DTLS buy nothing over it, and this would sidestep the candidate
question entirely rather than working around it. It is a second implementation
of the channel behind `Framing`, plus an IPC bridge that base64s every byte
until `tauri::ipc::Response` is used, and it would mean two code paths through
`DocSyncProtocol` to keep honest. Held as the fallback if candidate rewriting
turns out not to work on a real pair of devices, which is a question only
testing answers.

**Store the address on the pair.** `device_pairs` has a row per peer and a
column would have been less code than a table. An address is not one value: a
device can be worth trying at a MagicDNS name and at a literal, and the whole
point of the prober is that some of them will be wrong. A table also lets an
address exist before a pairing does, which is what makes pairing over a tailnet
possible at all.

**Bring the broker back, with payloads sealed to the recipient.** Still the
right answer for two devices that share no network and no VPN, and ADR 0022
already sketched it. It remains more infrastructure for the user to run, which
is the thing that ADR was about; this change costs them nothing they are not
already running.

## Consequences

- **A device that has a stored address and answers a probe is reachable, so
  `canSignal` stops meaning "mDNS is up".** ADR 0018 introduced that name so no
  single transport could define whether the app can sync, ADR 0022 collapsed it
  onto the one transport left, and this is it going back into the seam it was
  built for.
- **iOS gains a route it can actually use.** The `NWBrowser` backend is still
  missing and local discovery there still finds nobody, but a typed address
  needs no multicast, so an iOS device with Tailscale can pair and sync. That
  does not close the iOS gap, it changes it from "no sync at all" to "no sync
  without an address".
- **This device's private addresses are published to a peer it is pairing or
  paired with, over a signed envelope addressed to that peer.** mDNS candidate
  obfuscation exists to stop a web page learning a visitor's LAN addresses; the
  recipient here is the user's own device, and the mDNS advertisement on the
  local route has always carried the same addresses in clear to everyone on the
  network. The exposure is smaller than the one we already accept, and it is
  the direct cost of decision 6.
- **Anyone who can reach the port and already knows this device's node_id can
  confirm it is running.** A `ping` is only answered when it is correctly
  addressed and correctly signed by some key, and the reply says nothing but
  "that node is here". On a tailnet the set of people who can reach the port is
  the user's own tailnet; on a LAN it is a network that can already see the
  mDNS advertisement, which says more.
- **A wrong address is quiet rather than loud.** The prober tries, fails and
  leaves the device offline in the list, which is indistinguishable from the
  device being off. The settings screen shows the last time each address
  answered, so a never-answered address is at least visible as such.
- **Probing costs a connection per address per interval, forever.** It is one
  frame each way on a path the user is already paying for, at 45 seconds, and
  only for devices that are not currently connected.
