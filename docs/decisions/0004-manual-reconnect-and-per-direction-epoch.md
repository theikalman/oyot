# 0004: Bring back a manual "Reconnect", track the epoch per direction

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** part of [0002](0002-signaling-retry-and-perfect-negotiation.md)
  (decision 2, "The manual 'Reconnect' button is removed", and the
  "Keeping the manual 'Reconnect' button as a fallback" rejection)

## Context

[ADR 0002](0002-signaling-retry-and-perfect-negotiation.md) removed the manual
"Reconnect" button on the theory that the automatic paths (startup sweep,
signaling-recovery sweep, per-peer backoff on drop) make it redundant, and that a
manual trigger mid-backoff "just races `ensurePeerConnection` against itself".

In practice the automatic-only story is not enough:

- After a long outage the per-peer backoff caps at 30s. A user watching two
  devices that should sync has no way to say "try now" - they wait out the timer.
- The backoff only fires on an observed drop. If a device was asleep / offline
  when the peer dropped, nothing is scheduled until the next sweep.

We also found a latent bug while wiring the button back up. The epoch tag from
ADR 0002 decision 4 is a single per-session counter bumped on every local
rebuild, but it was compared against the *remote's* counter:

```
if (env.epoch > 0 && env.epoch < session.epoch) { /* treat as stale */ }
```

The two counters advance independently - each side bumps its own on its own
rebuilds. Any time one side rebuilds more often than the other (which a manual
reconnect does deliberately, and an asymmetric failure does incidentally), the
higher-count side rejects the lower-count side's *current* offers and answers as
"stale" and no connection can form. Observed: local at epoch 11 dropping the
peer's epoch-8 offers indefinitely, plus the peer's epoch-8 answer to local's own
epoch-12 offer.

## Decision

**1. Re-add a user-triggered `reconnectPeer(peerNodeId)`.** It cancels the pending
backoff timer, resets the attempt counter, clears any explicit-disconnect
suppression, and calls `ensurePeerConnection({ initiate: true, force: true })` -
initiating unconditionally, even when this side is the polite peer, so the click
does not sit on the promote timeout. Perfect negotiation absorbs the collision if
both peers click at once (same as the pairing path's `initiateOffer`). No-op if
already connected or if MQTT signaling is down. Surfaced in two places: a
per-device three-dot menu item in the sidebar's "Connected Devices" list, and a
button on the sync settings page. Both stay live while a backoff retry is
pending - that is the case the button exists for.

**2. Track the epoch per direction.** `PeerSession` gains `peerEpoch`, the highest
epoch seen *from* the peer. Incoming descriptions/candidates are stale only when
`env.epoch < session.peerEpoch` (the peer's own counter went backwards);
`session.epoch` is still bumped on every local rebuild and still sent on our
outgoing messages so the peer can do the same check against us. `peerEpoch`
survives a local rebuild (`existing?.peerEpoch ?? 0`).

## Alternatives considered

**Reset our epoch down to the peer's on a forced reconnect.** Roughly the same
information as `peerEpoch` but hackier, and still wrong for the incidental
asymmetric-failure case that has nothing to do with the button. Per-direction
tracking fixes both.

**Drop the epoch check entirely and lean on perfect negotiation's signaling-state
guards.** They catch a stale *answer* applied in the wrong state (it throws, we
catch), but a stale *offer* from a superseded negotiation would still trigger a
needless rollback churn. Keeping the check, corrected, is cheap.

**Keep the button automatic-only (status hint, no action), per ADR 0002.**
Rejected for the reasons in Context - the 30s cap and the asleep-during-drop gap
are real and the fix is one function.

## Consequences

- A forced reconnect on the polite side now creates a data channel and offers
  immediately, so a manual click and an in-flight sweep/promotion can both offer.
  This is the collision perfect negotiation already handles; the extra path is
  `initiate: true` on a side that would otherwise wait.
- With `peerEpoch`, a local rebuild no longer "for free" suppresses the peer's
  not-yet-updated offers - they are processed and perfect negotiation resolves
  the collision. This is more correct (those offers reflect the peer's real
  state) at the cost of a little more negotiation traffic right after a rebuild.
- Mixed-version rollout: an un-updated peer still compares `env.epoch` against its
  own `session.epoch`, so a forced reconnect from an updated device can still be
  rejected by an old one until both sides update. Both ends are the same user's
  devices, so this converges quickly in practice.
- ADR 0002's "a user who wants a device gone uses Remove; a user who wants to
  pause syncing uses Disconnect" still holds - Reconnect is the third case
  (want it back now), not a replacement for either.
