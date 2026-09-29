# 0033: Hash what a document holds, not how it is encoded

- **Status:** Accepted
- **Date:** 2026-09-28
- **Amends:** [0003](0003-full-document-set-sync.md) decision 2 (the content
  hash)
- **Extends:** [0031](0031-move-the-sync-engine-into-rust.md)

## Context

The manifest compares documents by `content_hash`: the SHA-256 of the merged
Yjs state, as `Y.encodeStateAsUpdate` writes it. ADR 0003 chose it on the
grounds that Yjs encodes a given set of operations deterministically, so equal
bytes mean equal documents on every device.

Once the merge is in Rust ([ADR 0031](0031-move-the-sync-engine-into-rust.md)),
`yrs` writes the stored state, and its bytes are not the ones Yjs would write.
Both use the same format and each reads the other's, but they differ in the
details. Yjs writes the deleted ranges in descending order of client id, and
`yrs` in ascending order. So two copies of a document with exactly the same
content, one last written by each library, hash differently. The Yjs author
calls differing encodings expected behaviour. Byte equality across
implementations, or even across versions of one, is something neither
promises.

A hash that never matches is never wrong, only wasteful: that document is
exchanged again on every connection, one state-vector round trip each time. On
a phone with 30 seconds to sync (ADR 0034), that waste can use up the whole
run.

## Decision

**1. The hash covers what the document holds.** A Yjs document is determined by
two things:

- which operations it has, which its state vector records
- which of those are deleted, which its delete set records

`content_hash` becomes the SHA-256 of a fixed encoding of those two:

- for each client in ascending order, its id and clock
- then for each client in ascending order, its deleted ranges, sorted, and
  merged where they touch or overlap

Integers are fixed-width and big-endian, so no library's encoder is involved.

**2. Rust computes it whenever the stored state changes.** Today the webview
computes it; Rust only writes it, in the same statement as `crdt_state`, and
that part stays. The manifest still costs one query and no CRDT work, which is
why ADR 0003 chose a hash in the first place. The one-time backfill that
writes a hash on its own (`set_content_hash`) goes, since decision 4's
migration replaces it.

**3. A document holding updates it cannot apply yet has no hash.** An update
that arrives before one it depends on is kept aside as pending, and the state
vector does not show it. The core stores pending updates with the document, as
Yjs's encoding does today, so a restart does not drop them. Until they apply,
the document is left with an empty hash, which reconcile already treats as
unknown and exchanges.

**4. An empty document has a hash too:** the one for an empty state vector and
an empty delete set. Today a row with no content has no hash, so every
connection exchanges every such row again. A year of daily journals nobody
wrote in is hundreds of round trips per connection, which a phone's 30-second
run cannot spare. Now two empty rows match.

**5. The old hashes are cleared by a migration, and rebuilt a row at a time.**
The new definition matches nothing the old one produced.

- The migration only clears the column. Decoding every document inside it
  would put the app's start at the mercy of the one document `yrs` cannot
  read: migrations run in one transaction, and a failed one stops the app
  from starting at all.
- The core then recomputes each row's hash outside startup. A row it cannot
  decode keeps no hash, and is exchanged.
- Until a row has its new hash, it is exchanged like any unknown.

## Alternatives considered

**Keep hashing the encoded bytes, and let only Rust encode.** Every device
would run the same `yrs` and write the same bytes, until two devices run
different versions of it, or an encoder changes its order. Nothing promises
that it will not.

**Put state vectors in the manifest instead of a hash.** ADR 0003 rejected
this for the Yjs work it cost on every connection. Stored as a column, that
cost would go. But a state vector grows with every client that ever edited the
document, where a hash stays at 32 bytes. And a state vector alone misses
deletions, which add nothing to it.

**Compare the rendered text.** It misses formatting, attributes and anything
the index does not read, and it needs the editor's schema.

## Consequences

- Equal content hashes equal on every device, whichever library encoded it,
  and whichever version.
- A deletion changes the hash, since it changes the delete set, even though it
  adds nothing to the state vector.
- Hashing reads the document's structure on each write, where before it hashed
  bytes already in hand. Rust has just merged into that structure, so the
  state vector and delete set come from the same transaction.
- Importing a backup (ADR 0024) compares each document by the backup's own
  checksum of its state, which is a hash of the bytes. The import computes the
  new hash from each state it reads instead. Otherwise every note in a backup
  would look changed, and be merged and indexed again.
- The backup format does not change. It keeps its checksum, which is there to
  catch a damaged file rather than to compare content.
- It is part of the breaking release with ADRs 0031 and 0032. An old build and
  a new one would never find a hash in common, but they do not talk to each
  other anyway (ADR 0032, decision 9).
