# 0006: Every `sync-need` gets an answer

- **Status:** Accepted
- **Date:** 2026-08-29
- **Refines:** [0003](0003-full-document-set-sync.md) (phase 2, the delta pull)

## Context

Phase 2 of the reconciliation ([ADR 0003](0003-full-document-set-sync.md)) has
the receiver send a `sync-need { id, stateVector }` for every document whose
content hash differs, and the holder reply with a `sync-delta`. The holder's
`onNeed` only replied **when it had a non-empty delta**:

```ts
const update = await this.repo.computeDelta(id, sv);
if (update) this.send({ t: 'sync-delta', id, update });
```

`computeDelta` returns nothing when the asker is equal-or-ahead on that document
- which is the normal case whenever the *other* device made the offline edits.
So a routine one-directional edit left the ahead side's `sync-need` unanswered.
That side then waited out `NEED_TIMEOUT_MS` twice (2 x 20s), logged
`gave up pulling <id> after 2 attempts`, and only then settled the doc.

Consequences of the silent path:

- `onSynced` is gated on `queue` and `inFlight` both draining, so the whole
  connection's "synced" status, the `update_pair_sync_time` write, and the
  progress UI were held back ~40s by any such document - several of them in a
  typical reconnect.
- With `MAX_IN_FLIGHT = 4`, four such documents hold every slot for the timeout
  window, delaying healthy documents queued behind them.
- Document *content* still converged (the other direction's `sync-delta` carried
  it); only the completion signal and throughput suffered.

## Decision

`onNeed` **always** answers. When there is no delta - or `computeDelta` throws -
it sends a new `sync-none { id }` message. The asker's `onNone` clears the
in-flight entry and its timeout and settles the document immediately, exactly as
`onDelta` does minus the merge.

Folded into protocol **v3** (same unreleased version as the attachment work in
[ADR 0005](0005-attachment-sync.md)); no separate version step. A v2 peer never
reached phase 2 anyway - the `hello` mismatch stops it at reconciliation.

## Alternatives considered

**Send `sync-delta` with an empty update.** `mergeDelta` would then feed a
zero-length array to `Y.applyUpdate`, which throws. A distinct message is
cleaner than a sentinel the merge path has to special-case.

**Drop the give-up from the `onSynced` gate instead.** Treats the symptom: the
status would settle, but the asker still burns two 20s timeouts and the log
still fills with give-up warnings for what is a healthy sync. Answering at the
source fixes both.

**Shorten `NEED_TIMEOUT_MS`.** Trades one arbitrary delay for a smaller one and
makes a genuinely slow delta more likely to be abandoned. The timeout is for a
lost message, not for an expected non-answer.

## Consequences

- `gave up pulling <id>` now means an actually lost or unanswered message, not
  "the peer had nothing" - it should be rare and worth investigating.
- One extra tiny message per differing-but-not-pullable document. Negligible
  next to the `sync-manifest` that already listed them.
- `sync-none` is required for a clean v3 exchange; a hypothetical peer that sent
  `sync-need` but not `sync-none` would strand the other side the old way.
