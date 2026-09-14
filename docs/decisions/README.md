# Decision Log

This directory tracks architecture decision records (ADRs) for Oyot: the
significant technical choices, the alternatives considered, and why we
picked what we picked. Each record is numbered and immutable once accepted

- if a decision is later reversed, add a new ADR that supersedes it rather
  than editing the old one.

## Index

| #                                                           | Title                                                                      | Status   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| [0001](0001-mqtt-over-iroh-for-signaling.md)                | Use MQTT over Iroh's public relay for WebRTC signaling                     | Accepted |
| [0002](0002-signaling-retry-and-perfect-negotiation.md)     | MQTT reconnect and perfect negotiation for peer connections                | Accepted |
| [0003](0003-full-document-set-sync.md)                      | Reconcile the whole document set with a manifest + delta protocol          | Accepted |
| [0004](0004-manual-reconnect-and-per-direction-epoch.md)    | Bring back a manual "Reconnect", track the epoch per direction             | Accepted |
| [0005](0005-attachment-sync.md)                             | Sync image attachments as content-addressed blobs alongside the CRDT       | Accepted |
| [0006](0006-answer-every-sync-need.md)                      | Every `sync-need` gets an answer (`sync-none` when there is no delta)      | Accepted |
| [0007](0007-drop-protocol-version.md)                       | Drop the sync protocol version and the `hello` handshake                   | Accepted |
| [0008](0008-deletion-as-last-writer-wins.md)                | Make deletion a last-writer-wins register                                  | Accepted |
| [0009](0009-authenticated-signaling.md)                     | Sign signaling messages, make node_id a public key                         | Accepted |
| [0010](0010-apply-remote-updates-into-the-open-document.md) | Apply remote updates into the open document, serialise writes per document | Accepted |
| [0011](0011-boot-id-for-signaling-sessions.md)              | Identify a signaling session by boot id, not epoch alone                   | Accepted |

## Format

Each ADR follows a lightweight structure:

- **Status** - proposed, accepted, superseded, etc.
- **Context** - the problem and constraints that forced a decision.
- **Decision** - what we chose.
- **Alternatives considered** - what else we looked at and why it lost.
- **Consequences** - trade-offs we accepted, including known weaknesses.
