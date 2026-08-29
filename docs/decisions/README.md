# Decision Log

This directory tracks architecture decision records (ADRs) for Oyot: the
significant technical choices, the alternatives considered, and why we
picked what we picked. Each record is numbered and immutable once accepted
- if a decision is later reversed, add a new ADR that supersedes it rather
than editing the old one.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-mqtt-over-iroh-for-signaling.md) | Use MQTT over Iroh's public relay for WebRTC signaling | Accepted |
| [0002](0002-signaling-retry-and-perfect-negotiation.md) | MQTT reconnect and perfect negotiation for peer connections | Accepted |
| [0003](0003-full-document-set-sync.md) | Reconcile the whole document set with a manifest + delta protocol | Accepted |
| [0004](0004-manual-reconnect-and-per-direction-epoch.md) | Bring back a manual "Reconnect", track the epoch per direction | Accepted |

## Format

Each ADR follows a lightweight structure:

- **Status** - proposed, accepted, superseded, etc.
- **Context** - the problem and constraints that forced a decision.
- **Decision** - what we chose.
- **Alternatives considered** - what else we looked at and why it lost.
- **Consequences** - trade-offs we accepted, including known weaknesses.
