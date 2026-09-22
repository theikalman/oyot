# 0016: Binary chunk frames, and a development broker that is anonymous on purpose

- **Status:** Accepted, amended by [0022](0022-drop-the-broker-and-sync-only-on-the-local-network.md), which
  removes the broker and with it the development broker described here. The
  binary chunk framing is untouched
- **Date:** 2026-09-14
- **Amends:** [0005](0005-attachment-sync.md) (the framing and timeout
  assumptions) and [0009](0009-authenticated-signaling.md) (what the reference
  broker configuration is for)

## Context

**The broker shipped in this repository could not serve the app.**
`mosquitto.conf` set `allow_anonymous false` and pointed at a password file
that has to be created by hand first, its ACL had every read rule commented
out, and the client had no way to send credentials at all. The README presents
`docker compose up -d` as the one-line development setup, and DEVELOPMENT
described authentication as a feature that existed. None of it worked, and the
compose healthcheck reported the container unhealthy for ever because it
subscribes anonymously.

**Attachments were base64 encoded twice.** Rust hands the bytes to the webview
as base64, the protocol puts that in a JSON message, and the framing layer
base64 encoded the whole thing again to slice it into JSON chunk frames. A
10MB image left as roughly 18MB, with several copies resident on the receiver.
The attachment timeout was a flat 30 seconds regardless of size, so the large
transfers, the ones that need the time, were the ones that timed out, and the
retry started a second full transfer beside the first.

Two smaller things in the same layer: `send` reported nothing, so a message
dropped for a closed channel or an over-size payload looked exactly like a
peer that chose not to answer; and a short message could overtake a chunked
one that was parked waiting for the send buffer to drain.

## Decision

**1. The development broker is anonymous, on every interface, and says so.**
This is coherent with [ADR 0009](0009-authenticated-signaling.md) rather than
a relaxation of it: signatures are what make a message trustworthy, a node_id
is a public key, and pairing still requires confirming that id by hand. The
broker's remaining power is to read who is pairing with whom, which is
acceptable on a development LAN and is stated in the file. Binding to
localhost would defeat the purpose, which is pairing a laptop with a phone.

**2. The hardened configuration is a separate, complete example.**
`mosquitto.prod.conf.example` and `acl.example`, with the read rules filled in
rather than commented out, and a place for TLS.

**3. The client sends credentials, as separate fields.** Not embedded in the
URL: a password in a URL ends up in every log line that prints the URL, and it
makes host and port ambiguous to parse. They are stored in the same plaintext
`config.json` as everything else, which is the same posture as the signing key
and is documented rather than implied.

**4. Chunk payloads are binary frames** with a fixed eight-byte header (message
id, chunk index). Control frames stay JSON: they are small, and being able to
read them in a log is worth more than the bytes.

**5. Sends are queued per channel**, so two messages cannot interleave.

**6. `send` reports whether the message reached the channel.**

**7. The attachment timeout scales with the announced size**, with the old flat
value as a floor.

## Alternatives considered

**Keep one broker configuration and make the client authenticate.** The
obvious reading of "the docs say auth, so implement auth". Rejected as the
default: it makes every developer create a password file before the app can
connect at all, for a control that ADR 0009 already says is not what makes a
message trustworthy. Credentials are implemented, but as the thing you turn on
for a broker that leaves your network.

**Bind the development broker to localhost.** Safer by default. Rejected: the
only reason to run it is to pair two devices, and a phone cannot reach
localhost on a laptop.

**Accept the username and password in the URL, `mqtt://user:pass@host`.**
Fewer fields, and familiar. Rejected for the logging and parsing reasons
above.

**Keep base64 chunks and accept the cost.** No change to the wire format and
nothing to get wrong. Rejected: it is 1.33x on exactly the messages that are
already the largest, and the framing layer is where it is cheapest to fix.

**Reset the attachment deadline as chunks arrive, rather than sizing it up
front.** More accurate, and it would notice a transfer that stalls halfway.
Rejected for now because the framing layer reassembles a message before
handing it up, so progress is not visible to the protocol; exposing it is more
plumbing than the problem currently justifies.

## Consequences

- `docker compose up -d` produces a broker two devices can actually pair
  through, which is what the README always claimed.
- A protocol change with no negotiation, as
  [ADR 0007](0007-drop-protocol-version.md) accepts: a device on the previous
  build will drop every chunked message from a device on this one, because it
  expects a JSON frame where a binary one arrives. Whole messages under 16KB
  still work, so the two will partly sync until both are updated. This is the
  clearest case yet of what ADR 0007 gave up.
- Attachment transfer is roughly 1.33x cheaper on the wire, and a large image
  over a slow link is no longer abandoned mid-flight. The base64 between Rust
  and the webview remains; removing it means moving those bytes over IPC as
  raw binary.
- Broker credentials sit in plaintext on disk. Stated in the docs; the same is
  already true of the signing key, and fixing either properly means the OS
  keychain.
