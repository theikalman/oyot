//! The CRDT work Rust does: merging updates into a stored document, and hashing
//! what a document holds (ADR 0031, decision 3; ADR 0033).
//!
//! The editor is Yjs, in the webview; this is `yrs`, which reads and writes
//! the same update format but does not write the same bytes. So nothing here
//! compares encodings. The stored state is only ever merged into, and the
//! change detector is a hash of the document's state vector and delete set,
//! which is the same for the same content whichever library wrote it.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, Snapshot, StateVector, Transact, Update};

/// The length of Yjs's encoding of "nothing": an update this short holds no
/// content. Mirrors `EMPTY_UPDATE_LEN` in the webview's protocol.ts.
pub const EMPTY_UPDATE_LEN: usize = 2;

/// Names the hash's encoding, so that if it ever changes, a hash of the old
/// kind cannot equal one of the new.
const DIGEST_TAG: &[u8] = b"oyot-content-v1";

/// A document after a merge, ready to store.
#[derive(Debug)]
pub struct Merged {
    /// The whole state, updates that could not be applied yet included.
    pub state: Vec<u8>,
    /// The state vector, for the editor to send its next save against.
    pub state_vector: Vec<u8>,
    /// `None` while the document holds updates it cannot apply yet (ADR 0033,
    /// decision 3), which the manifest reads as "exchange".
    pub content_hash: Option<[u8; 32]>,
    /// What the update added to the stored state, as an update a device
    /// holding the stored state needs, or `None` when it added nothing: an
    /// update the state already held, or one still waiting on another. This
    /// is what peers are sent, rather than whatever the caller happened to
    /// hand in.
    pub delta: Option<Vec<u8>>,
}

/// Merge `update` into `stored`. Either may be empty.
///
/// Merging is what makes two writers safe: applying an update the state
/// already holds changes nothing, so neither can erase the other's work the way
/// overwriting the column did.
pub fn merge(stored: &[u8], update: &[u8]) -> Result<Merged, String> {
    let doc = Doc::new();
    apply(&doc, "stored state", stored)?;
    // What the stored state holds, to tell what the update added to it. The
    // digest rather than the snapshot itself, since only the digest puts the
    // deletions in one order.
    let (before, before_sv) = {
        let txn = doc.transact();
        (digest(&txn.snapshot()), txn.state_vector())
    };
    apply(&doc, "update", update)?;

    let txn = doc.transact();
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    let state_vector = txn.state_vector().encode_v1();
    let after = digest(&txn.snapshot());
    let content_hash = (!txn.has_missing_updates()).then_some(after);
    // Everything since the stored state vector, with the whole delete set,
    // as Yjs would send a peer at that vector: a deletion moves no clock, so
    // the vector alone would miss one.
    let delta = (after != before).then(|| txn.encode_state_as_update_v1(&before_sv));
    Ok(Merged {
        state,
        state_vector,
        content_hash,
        delta,
    })
}

fn apply(doc: &Doc, what: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() <= EMPTY_UPDATE_LEN {
        return Ok(());
    }
    let decoded =
        Update::decode_v1(bytes).map_err(|e| format!("the {what} cannot be read: {e}"))?;
    doc.transact_mut()
        .apply_update(decoded)
        .map_err(|e| format!("the {what} cannot be applied: {e}"))
}

/// The content hash of a stored state, for rows written before Rust hashed
/// them and for a backup being imported.
pub fn hash_state(state: &[u8]) -> Result<Option<[u8; 32]>, String> {
    Ok(merge(state, &[])?.content_hash)
}

/// The content hash of a document with nothing in it (ADR 0033, decision 4).
pub fn empty_hash() -> [u8; 32] {
    digest(&Snapshot::default())
}

/// Base64, the way hashes cross IPC and the wire.
pub fn encode_hash(hash: &[u8; 32]) -> String {
    BASE64.encode(hash)
}

/// SHA-256 over a fixed encoding of the state vector and the delete set.
///
/// - `DIGEST_TAG`
/// - the number of clients in the state vector, then each client in ascending
///   order with its clock
/// - the number of clients with deletions, then each client in ascending order
///   with its number of ranges and each range's start and end
///
/// Every integer is a big-endian u64. Ranges are sorted and merged where they
/// touch or overlap first, so two stores that recorded the same deletions in
/// different pieces hash alike.
pub fn digest(snapshot: &Snapshot) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DIGEST_TAG);

    let mut clocks: Vec<(u64, u64)> = snapshot
        .state_map
        .iter()
        .filter(|(_, clock)| **clock > 0)
        .map(|(client, clock)| (client.get(), u64::from(*clock)))
        .collect();
    clocks.sort_unstable();
    hasher.update((clocks.len() as u64).to_be_bytes());
    for (client, clock) in clocks {
        hasher.update(client.to_be_bytes());
        hasher.update(clock.to_be_bytes());
    }

    let mut deletions: Vec<(u64, Vec<(u64, u64)>)> = snapshot
        .delete_set
        .iter()
        .map(|(client, ranges)| {
            let ranges = ranges
                .iter()
                .map(|range| (u64::from(range.start), u64::from(range.end)))
                .collect();
            (client.get(), normalise(ranges))
        })
        .filter(|(_, ranges)| !ranges.is_empty())
        .collect();
    deletions.sort_unstable_by_key(|(client, _)| *client);
    hasher.update((deletions.len() as u64).to_be_bytes());
    for (client, ranges) in deletions {
        hasher.update(client.to_be_bytes());
        hasher.update((ranges.len() as u64).to_be_bytes());
        for (start, end) in ranges {
            hasher.update(start.to_be_bytes());
            hasher.update(end.to_be_bytes());
        }
    }

    hasher.finalize().into()
}

/// Ranges sorted, with empty ones dropped and ones that touch or overlap joined.
fn normalise(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.retain(|(start, end)| end > start);
    ranges.sort_unstable();
    let mut joined: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match joined.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => joined.push((start, end)),
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text};

    /// A document from one client, with `text` in a Y.Text, as an update.
    fn written(client: u64, text: &str) -> Vec<u8> {
        let doc = Doc::with_client_id(client);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, text);
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        state
    }

    fn text_of(state: &[u8]) -> String {
        let doc = Doc::new();
        let body = doc.get_or_insert_text("body");
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
        let text = body.get_string(&doc.transact());
        text
    }

    #[test]
    fn merging_into_nothing_keeps_the_update() {
        let merged = merge(&[], &written(1, "hello")).unwrap();
        assert_eq!(text_of(&merged.state), "hello");
        assert!(merged.content_hash.is_some());
    }

    #[test]
    fn merging_the_same_update_twice_changes_nothing() {
        let update = written(1, "hello");
        let once = merge(&[], &update).unwrap();
        let twice = merge(&once.state, &update).unwrap();
        assert_eq!(once.content_hash, twice.content_hash);
        assert_eq!(text_of(&twice.state), "hello");
    }

    #[test]
    fn neither_of_two_writers_is_lost() {
        let a = written(1, "one");
        let b = written(2, "two");
        let ab = merge(&merge(&[], &a).unwrap().state, &b).unwrap();
        let ba = merge(&merge(&[], &b).unwrap().state, &a).unwrap();
        let text = text_of(&ab.state);
        assert!(text.contains("one") && text.contains("two"), "{text}");
        assert_eq!(ab.content_hash, ba.content_hash);
    }

    #[test]
    fn a_deletion_changes_the_hash_without_changing_the_state_vector() {
        let doc = Doc::with_client_id(1);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, "hello");
        let before = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        body.remove_range(&mut doc.transact_mut(), 0, 2);
        let after = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        let before = merge(&[], &before).unwrap();
        let after = merge(&[], &after).unwrap();
        assert_eq!(before.state_vector, after.state_vector);
        assert_ne!(before.content_hash, after.content_hash);
    }

    #[test]
    fn an_update_missing_what_it_depends_on_has_no_hash_until_that_arrives() {
        let doc = Doc::with_client_id(1);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, "first");
        let first = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let sv = doc.transact().state_vector();
        body.insert(&mut doc.transact_mut(), 5, " second");
        let second = doc.transact().encode_state_as_update_v1(&sv);

        let pending = merge(&[], &second).unwrap();
        assert_eq!(pending.content_hash, None);

        // Kept with the document, and applied once the first arrives.
        let complete = merge(&pending.state, &first).unwrap();
        assert!(complete.content_hash.is_some());
        assert_eq!(text_of(&complete.state), "first second");
    }

    #[test]
    fn an_update_the_state_already_holds_adds_nothing_to_send() {
        let update = written(1, "hello");
        let once = merge(&[], &update).unwrap();
        assert!(once.delta.is_some());
        assert!(merge(&once.state, &update).unwrap().delta.is_none());
    }

    #[test]
    fn what_a_merge_added_brings_the_stored_state_up_to_the_merged_one() {
        let stored = written(1, "one");
        let merged = merge(&stored, &written(2, "two")).unwrap();

        let caught_up = merge(&stored, &merged.delta.unwrap()).unwrap();

        assert_eq!(caught_up.content_hash, merged.content_hash);
    }

    #[test]
    fn a_deletion_on_its_own_is_something_to_send() {
        let doc = Doc::with_client_id(1);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, "hello");
        let stored = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let sv = doc.transact().state_vector();
        body.remove_range(&mut doc.transact_mut(), 0, 2);
        let deletion = doc.transact().encode_state_as_update_v1(&sv);

        let merged = merge(&stored, &deletion).unwrap();
        let caught_up = merge(&stored, &merged.delta.unwrap()).unwrap();

        assert_eq!(text_of(&caught_up.state), "llo");
    }

    #[test]
    fn an_update_still_waiting_on_another_is_not_sent_until_it_applies() {
        let doc = Doc::with_client_id(1);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, "first");
        let first = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let sv = doc.transact().state_vector();
        body.insert(&mut doc.transact_mut(), 5, " second");
        let second = doc.transact().encode_state_as_update_v1(&sv);

        let pending = merge(&[], &second).unwrap();
        assert!(pending.delta.is_none());

        let complete = merge(&pending.state, &first).unwrap();
        assert_eq!(text_of(&complete.delta.unwrap()), "first second");
    }

    #[test]
    fn an_empty_document_has_the_empty_hash() {
        assert_eq!(hash_state(&[]).unwrap(), Some(empty_hash()));
        assert_eq!(hash_state(&[0, 0]).unwrap(), Some(empty_hash()));
    }

    /// The webview spells this one out as `EMPTY_CONTENT_HASH` (protocol.ts),
    /// to tell an empty document from an unknown one.
    #[test]
    fn the_empty_hash_is_the_one_the_webview_knows() {
        assert_eq!(
            encode_hash(&empty_hash()),
            "ah3hKNJyMsJEp/6RKVqPp83Gx1jymaAbctmSIACZgio="
        );
    }

    #[test]
    fn a_document_with_content_does_not_have_the_empty_hash() {
        assert_ne!(hash_state(&written(1, "x")).unwrap(), Some(empty_hash()));
    }

    #[test]
    fn bytes_that_are_not_an_update_are_an_error() {
        assert!(merge(&[1, 2, 3, 4, 5], &[]).is_err());
    }

    #[test]
    fn ranges_are_sorted_and_joined() {
        assert_eq!(
            normalise(vec![(5, 7), (0, 2), (2, 3), (6, 9), (10, 10)]),
            vec![(0, 3), (5, 9)]
        );
    }

    /// The documents the real editor writes (crdtInterop.test.ts generates
    /// them). yrs has to hash each exactly as Yjs does, and write something
    /// Yjs reads back the same.
    mod interop {
        use super::super::*;
        use serde::Deserialize;
        use std::path::PathBuf;

        #[derive(Deserialize)]
        struct Fixture {
            name: String,
            updates: Vec<String>,
            state: String,
            digest: Option<String>,
            missing: Option<String>,
            #[serde(rename = "completeDigest")]
            complete_digest: Option<String>,
        }

        fn dir() -> PathBuf {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/crdt")
        }

        fn fixtures() -> Vec<Fixture> {
            ["rich", "edited", "empty", "pending"]
                .iter()
                .map(|name| {
                    let path = dir().join(format!("{name}.json"));
                    let text = std::fs::read_to_string(&path)
                        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
                    serde_json::from_str(&text).unwrap()
                })
                .collect()
        }

        fn bytes(b64: &str) -> Vec<u8> {
            BASE64.decode(b64).unwrap()
        }

        fn hash_of(state: &[u8]) -> Option<String> {
            hash_state(state).unwrap().map(|h| encode_hash(&h))
        }

        #[test]
        fn yrs_hashes_what_the_editor_wrote_as_yjs_does() {
            for fixture in fixtures() {
                assert_eq!(
                    hash_of(&bytes(&fixture.state)),
                    fixture.digest,
                    "{}",
                    fixture.name
                );
            }
        }

        #[test]
        fn yrs_merges_the_editors_updates_to_the_same_hash_in_any_order() {
            for fixture in fixtures() {
                let updates: Vec<Vec<u8>> = fixture.updates.iter().map(|u| bytes(u)).collect();
                for order in orders(updates.len()) {
                    let mut state = Vec::new();
                    for i in order {
                        state = merge(&state, &updates[i]).unwrap().state;
                    }
                    assert_eq!(hash_of(&state), fixture.digest, "{}", fixture.name);
                }
            }
        }

        #[test]
        fn a_pending_document_completes_when_its_update_arrives() {
            let fixture = fixtures()
                .into_iter()
                .find(|f| f.name == "pending")
                .unwrap();
            let pending = merge(&[], &bytes(&fixture.updates[0])).unwrap();
            assert_eq!(pending.content_hash, None);
            let complete =
                merge(&pending.state, &bytes(fixture.missing.as_ref().unwrap())).unwrap();
            assert_eq!(
                complete.content_hash.map(|h| encode_hash(&h)),
                fixture.complete_digest
            );
        }

        /// What yrs encodes has to hash the same when read back, and is
        /// written out for the Yjs side to read (OYOT_WRITE_FIXTURES=1).
        #[test]
        fn what_yrs_writes_reads_back_the_same() {
            let write = std::env::var("OYOT_WRITE_FIXTURES").as_deref() == Ok("1");
            for fixture in fixtures() {
                let state = fixture.updates.iter().fold(Vec::new(), |state, update| {
                    merge(&state, &bytes(update)).unwrap().state
                });
                assert_eq!(hash_of(&state), fixture.digest, "{}", fixture.name);
                if write {
                    std::fs::create_dir_all(dir().join("yrs")).unwrap();
                    std::fs::write(
                        dir().join("yrs").join(format!("{}.bin", fixture.name)),
                        &state,
                    )
                    .unwrap();
                }
            }
        }

        /// Every order of `n` items.
        fn orders(n: usize) -> Vec<Vec<usize>> {
            if n <= 1 {
                return vec![(0..n).collect()];
            }
            let mut all = Vec::new();
            for first in 0..n {
                for rest in orders(n - 1) {
                    let mut order = vec![first];
                    order.extend(rest.into_iter().map(|i| if i >= first { i + 1 } else { i }));
                    all.push(order);
                }
            }
            all
        }
    }

    #[test]
    fn the_hash_ignores_the_order_the_state_vector_iterates_in() {
        let state = merge(
            &merge(&[], &written(7, "a")).unwrap().state,
            &written(3, "b"),
        )
        .unwrap()
        .state;
        let a = hash_state(&state).unwrap();
        let b = hash_state(&state).unwrap();
        assert_eq!(a, b);
    }
}
