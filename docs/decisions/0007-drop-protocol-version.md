# 0007: Drop the sync protocol version and the `hello` handshake

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** [0003](0003-full-document-set-sync.md) decision 7 ("Protocol
  version 2, negotiated via `hello`"), and the mixed-version notes in
  [0005](0005-attachment-sync.md) and [0006](0006-answer-every-sync-need.md)

## Context

ADR 0003 gave the sync protocol a version number exchanged in a `hello` message.
On any mismatch, `DocSyncProtocol` set `incompatiblePeer`, called
`onPhase('error')`, and skipped reconciliation entirely.

Bumping the version 2 -> 3 for attachment sync ([ADR 0005](0005-attachment-sync.md))
made that path fire for the first time in practice. Connecting a device still on
the previous build produced:

- **"Error"** next to the device in the sidebar - alarming and unactionable.
- **Zero document sync in either direction** - `incompatiblePeer` gates
  `onManifest`, so not even plain-text documents (whose wire format never
  changed) reconciled.

The version check cost real complexity - a message type, an instance flag,
three guard clauses, a sink error phase, and the UI to explain it - to handle a
case that does not exist: the app is single-user, every device runs the same
build, and a build old enough to disagree on the wire format is a transient
state during the user's own update, not something to design around.

## Decision

Remove protocol versioning:

- Delete `SYNC_PROTOCOL_VERSION`, the `{ t: 'hello'; v }` message, the
  `incompatiblePeer` flag, and its guards in `onManifest`, `sendAttachManifest`,
  and `onAttachManifest`.
- `start()` sends the `sync-manifest` directly. Both peers assume the same wire
  format.

`onPhase('error')` stays for genuine failures (a manifest that cannot be built).

## Alternatives considered

**Negotiate the version down to the shared minimum** and gate only the messages
that changed the format. Correct, and what a multi-client protocol would do -
but it keeps every piece of the machinery plus adds a per-feature capability
check. Not worth it for an alpha, single-user app where the only mismatch is a
half-finished self-update.

**Keep the version but make a mismatch non-fatal** (sync documents, skip
attachments, show "needs update"). Smaller than full negotiation, still more
code than deleting the feature.

## Consequences

- A protocol change is now a breaking change with no guard rail: during the
  window where one device is updated and the other is not, they may exchange
  malformed messages. `isSyncMessage` + the per-message `try/catch` in the
  framing and handler paths contain the blast radius to "that message is
  dropped", and the mismatch clears as soon as both devices are on the new
  build. If the app ever gains real multi-user or staged rollout, reintroduce
  negotiation deliberately (this ADR is the thing to supersede).
- One less message on every connection, and a simpler `DocSyncProtocol`.
- The sidebar and settings list no longer have an "incompatible peer" state to
  render.
