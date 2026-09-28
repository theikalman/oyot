//! The session's tests, ported case by case from `DocSyncProtocol.test.ts`
//! (ADR 0031, decision 2), plus the ones for what changed: `sync-complete`
//! and image pieces.

use super::*;
use crate::crdt;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

// --- a repository in memory, on real yrs documents --------------------------

#[derive(Debug, Clone)]
struct Row {
    doc_type: String,
    title: String,
    title_updated_at: i64,
    created_at: i64,
    is_deleted: bool,
    deleted_at: Option<i64>,
    lifecycle_updated_at: i64,
    pinned: bool,
    pinned_updated_at: Option<i64>,
    state: Vec<u8>,
}

/// Mirrors `FakeRepo.ts`, which mirrors the database's rules: last writer
/// wins on the title, the pin (ties to pinned) and the lifecycle stamp, and
/// deleting drops the content.
#[derive(Default)]
struct FakeRepo {
    rows: RefCell<BTreeMap<String, Row>>,
    attachments: RefCell<BTreeMap<String, (String, Vec<u8>)>>,
    deltas_computed: Cell<usize>,
    delta_bytes: Cell<usize>,
}

fn state_with(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let body = doc.get_or_insert_text("content");
    body.insert(&mut doc.transact_mut(), 0, text);
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    state
}

fn load(state: &[u8]) -> Doc {
    let doc = Doc::new();
    doc.get_or_insert_text("content");
    if state.len() > crdt::EMPTY_UPDATE_LEN {
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
    }
    doc
}

/// `state` with `text` inserted at `index` by a device of its own.
fn edited(state: &[u8], index: u32, text: &str) -> Vec<u8> {
    let doc = load(state);
    let body = doc.get_or_insert_text("content");
    body.insert(&mut doc.transact_mut(), index, text);
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    state
}

impl FakeRepo {
    fn seed(&self, id: &str, text: &str, title_updated_at: i64) {
        self.rows.borrow_mut().insert(
            id.to_string(),
            Row {
                doc_type: "note".into(),
                title: id.into(),
                title_updated_at,
                created_at: 1,
                is_deleted: false,
                deleted_at: None,
                lifecycle_updated_at: 1,
                pinned: false,
                pinned_updated_at: None,
                state: state_with(text),
            },
        );
    }

    /// The same row, content and all, as another device holds it.
    fn copy_to(&self, other: &FakeRepo, id: &str) {
        let row = self.rows.borrow()[id].clone();
        other.rows.borrow_mut().insert(id.to_string(), row);
    }

    /// Like `copy_to`, but the other device has the row and none of the content.
    fn copy_row_only(&self, other: &FakeRepo, id: &str) {
        let mut row = self.rows.borrow()[id].clone();
        row.state = Vec::new();
        other.rows.borrow_mut().insert(id.to_string(), row);
    }

    fn edit(&self, id: &str, index: u32, text: &str) {
        let mut rows = self.rows.borrow_mut();
        let row = rows.get_mut(id).unwrap();
        row.state = edited(&row.state, index, text);
    }

    fn remove(&self, id: &str, at: i64) {
        let mut rows = self.rows.borrow_mut();
        let row = rows.get_mut(id).unwrap();
        row.is_deleted = true;
        row.deleted_at = Some(at);
        row.lifecycle_updated_at = at;
        row.state = Vec::new();
    }

    fn revive(&self, id: &str, at: i64, text: &str) {
        let mut rows = self.rows.borrow_mut();
        let row = rows.get_mut(id).unwrap();
        row.is_deleted = false;
        row.deleted_at = None;
        row.lifecycle_updated_at = at;
        row.state = state_with(text);
    }

    fn row(&self, id: &str) -> Row {
        self.rows.borrow()[id].clone()
    }

    fn has(&self, id: &str) -> bool {
        self.rows.borrow().contains_key(id)
    }

    fn text(&self, id: &str) -> String {
        let rows = self.rows.borrow();
        let Some(row) = rows.get(id) else {
            return String::new();
        };
        let doc = load(&row.state);
        let body = doc.get_or_insert_text("content");
        let text = body.get_string(&doc.transact());
        text
    }

    fn add_attachment(&self, hash: &str, mime: &str, bytes: Vec<u8>) {
        self.attachments
            .borrow_mut()
            .insert(hash.to_string(), (mime.to_string(), bytes));
    }

    fn attachment(&self, hash: &str) -> Option<(String, Vec<u8>)> {
        self.attachments.borrow().get(hash).cloned()
    }
}

impl Repo for FakeRepo {
    fn list_sync_state(&self) -> Result<Vec<ManifestEntry>, String> {
        Ok(self
            .rows
            .borrow()
            .iter()
            .map(|(id, row)| ManifestEntry {
                id: id.clone(),
                doc_type: row.doc_type.clone(),
                title: row.title.clone(),
                title_updated_at: row.title_updated_at,
                created_at: row.created_at,
                is_deleted: row.is_deleted,
                deleted_at: row.deleted_at,
                lifecycle_updated_at: Some(row.lifecycle_updated_at),
                pinned: Some(row.pinned),
                pinned_updated_at: row.pinned_updated_at,
                content_hash: if row.is_deleted {
                    None
                } else {
                    crdt::hash_state(&row.state)
                        .unwrap()
                        .map(|h| crdt::encode_hash(&h))
                },
            })
            .collect())
    }

    fn ensure_doc(&self, entry: &ManifestEntry) -> Result<(), String> {
        let mut rows = self.rows.borrow_mut();
        let stamp = entry.lifecycle_updated_at.unwrap_or(entry.created_at);
        if let Some(row) = rows.get_mut(&entry.id) {
            if row.is_deleted && row.lifecycle_updated_at < stamp {
                row.is_deleted = false;
                row.deleted_at = None;
                row.lifecycle_updated_at = stamp;
            }
            return Ok(());
        }
        rows.insert(
            entry.id.clone(),
            Row {
                doc_type: entry.doc_type.clone(),
                title: entry.title.clone(),
                title_updated_at: entry.title_updated_at,
                created_at: entry.created_at,
                is_deleted: false,
                deleted_at: None,
                lifecycle_updated_at: stamp,
                pinned: entry.pinned.unwrap_or(false),
                pinned_updated_at: entry.pinned_updated_at,
                state: Vec::new(),
            },
        );
        Ok(())
    }

    fn ensure_tombstone(&self, entry: &ManifestEntry) -> Result<(), String> {
        let mut rows = self.rows.borrow_mut();
        if rows.contains_key(&entry.id) {
            return Ok(());
        }
        let stamp = entry.lifecycle_updated_at.unwrap_or(entry.created_at);
        rows.insert(
            entry.id.clone(),
            Row {
                doc_type: entry.doc_type.clone(),
                title: entry.title.clone(),
                title_updated_at: entry.title_updated_at,
                created_at: entry.created_at,
                is_deleted: true,
                deleted_at: Some(entry.deleted_at.unwrap_or(stamp)),
                lifecycle_updated_at: stamp,
                pinned: false,
                pinned_updated_at: None,
                state: Vec::new(),
            },
        );
        Ok(())
    }

    fn apply_rename(&self, id: &str, title: &str, at: i64) -> Result<bool, String> {
        let mut rows = self.rows.borrow_mut();
        match rows.get_mut(id) {
            Some(row) if row.title_updated_at < at => {
                row.title = title.to_string();
                row.title_updated_at = at;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn apply_pin(&self, id: &str, pinned: bool, at: i64) -> Result<bool, String> {
        let mut rows = self.rows.borrow_mut();
        let Some(row) = rows.get_mut(id) else {
            return Ok(false);
        };
        let ours = row.pinned_updated_at.unwrap_or(0);
        if ours < at || (ours == at && pinned && !row.pinned) {
            row.pinned = pinned;
            row.pinned_updated_at = Some(at);
            return Ok(true);
        }
        Ok(false)
    }

    fn apply_delete(&self, id: &str, deleted_at: i64) -> Result<bool, String> {
        let mut rows = self.rows.borrow_mut();
        match rows.get_mut(id) {
            Some(row) if row.lifecycle_updated_at < deleted_at => {
                row.is_deleted = true;
                row.deleted_at = Some(deleted_at);
                row.lifecycle_updated_at = deleted_at;
                row.state = Vec::new();
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn local_state_vector(&self, id: &str) -> Result<Vec<u8>, String> {
        let rows = self.rows.borrow();
        let state = rows.get(id).map(|r| r.state.clone()).unwrap_or_default();
        let sv = load(&state).transact().state_vector().encode_v1();
        Ok(sv)
    }

    fn compute_delta(&self, id: &str, sv: &[u8]) -> Result<Option<Vec<u8>>, String> {
        self.deltas_computed.set(self.deltas_computed.get() + 1);
        let rows = self.rows.borrow();
        let Some(row) = rows.get(id) else {
            return Ok(None);
        };
        let doc = load(&row.state);
        let since = if sv.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(sv).map_err(|e| e.to_string())?
        };
        let diff = doc.transact().encode_state_as_update_v1(&since);
        if diff.len() <= crdt::EMPTY_UPDATE_LEN {
            return Ok(None);
        }
        self.delta_bytes.set(diff.len());
        Ok(Some(diff))
    }

    fn merge_delta(&self, id: &str, update: &[u8]) -> Result<(), String> {
        let mut rows = self.rows.borrow_mut();
        let row = rows
            .get_mut(id)
            .ok_or_else(|| format!("mergeDelta for unknown {id}"))?;
        row.state = crdt::merge(&row.state, update)?.state;
        Ok(())
    }

    fn list_attachments(&self) -> Result<Vec<AttachmentEntry>, String> {
        Ok(self
            .attachments
            .borrow()
            .iter()
            .map(|(hash, (mime, bytes))| AttachmentEntry {
                hash: hash.clone(),
                mime: mime.clone(),
                size: bytes.len() as u64,
            })
            .collect())
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, String> {
        Ok(self.attachments.borrow().contains_key(hash))
    }

    fn read_attachment(&self, hash: &str) -> Result<Option<(String, Vec<u8>)>, String> {
        Ok(self.attachment(hash))
    }

    fn save_attachment(&self, hash: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
        self.add_attachment(hash, mime, bytes.to_vec());
        Ok(())
    }
}

// --- running two sessions against each other ---------------------------

#[derive(Default)]
struct Run {
    synced_a: bool,
    synced_b: bool,
    /// Every message, and which side it went to (true for A).
    sent: Vec<(bool, Message)>,
}

fn route(outs: Vec<Out>, to_a: bool, queue: &mut VecDeque<(bool, Message)>, synced: &mut bool) {
    for out in outs {
        match out {
            Out::Send(msg) => queue.push_back((to_a, msg)),
            Out::Synced { .. } => *synced = true,
            Out::Phase(_) | Out::Progress { .. } => {}
        }
    }
}

/// Run two sessions over an in-memory link until neither has anything to say.
fn converge(a: &FakeRepo, b: &FakeRepo) -> Run {
    let mut sa = Session::new();
    let mut sb = Session::new();
    let mut queue = VecDeque::new();
    let mut run = Run::default();

    route(sa.start(a, 0), false, &mut queue, &mut run.synced_a);
    route(sb.start(b, 0), true, &mut queue, &mut run.synced_b);

    let mut guard = 0;
    while let Some((to_a, msg)) = queue.pop_front() {
        guard += 1;
        assert!(guard < 10_000, "did not converge");
        run.sent.push((to_a, msg.clone()));
        if to_a {
            let outs = sa.handle(a, msg, 0);
            route(outs, false, &mut queue, &mut run.synced_a);
        } else {
            let outs = sb.handle(b, msg, 0);
            route(outs, true, &mut queue, &mut run.synced_b);
        }
    }
    run
}

fn assert_converged(a: &FakeRepo, b: &FakeRepo) {
    let ids: Vec<String> = a
        .rows
        .borrow()
        .keys()
        .chain(b.rows.borrow().keys())
        .cloned()
        .collect();
    for id in ids {
        assert!(a.has(&id), "{id} missing on A");
        assert!(b.has(&id), "{id} missing on B");
        let (ra, rb) = (a.row(&id), b.row(&id));
        assert_eq!(ra.is_deleted, rb.is_deleted, "{id} isDeleted mismatch");
        if !ra.is_deleted {
            assert_eq!(a.text(&id), b.text(&id), "{id} content mismatch");
            assert_eq!(ra.title, rb.title, "{id} title mismatch");
            assert_eq!(ra.pinned, rb.pinned, "{id} pin mismatch");
        }
    }
}

fn sends(outs: &[Out]) -> Vec<&Message> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Send(m) => Some(m),
            _ => None,
        })
        .collect()
}

// --- ported from DocSyncProtocol.test.ts ---------------------------------

#[test]
fn fresh_pair_a_has_documents_b_is_empty() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("d1", "hello", 1);
    a.seed("d2", "world", 1);
    a.seed("d3", "again", 1);

    let run = converge(&a, &b);

    assert!(run.synced_a && run.synced_b);
    assert_converged(&a, &b);
    assert_eq!(b.text("d2"), "world");
}

#[test]
fn disjoint_non_empty_sets_converge_both_directions() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("a1", "alpha", 1);
    a.seed("shared", "from-a", 1);
    b.seed("b1", "beta", 1);

    converge(&a, &b);
    assert_converged(&a, &b);
    assert_eq!(a.text("b1"), "beta");
    assert_eq!(b.text("a1"), "alpha");
}

#[test]
fn concurrent_divergent_edits_on_the_same_document_merge() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "base ", 1);
    a.copy_to(&b, "doc");
    a.edit("doc", 5, "A-edit ");
    b.edit("doc", 5, "B-edit ");

    converge(&a, &b);
    assert_converged(&a, &b);
    let merged = a.text("doc");
    assert!(
        merged.contains("A-edit") && merged.contains("B-edit"),
        "{merged}"
    );
}

// A journal's id is derived from its date, so deleting one and letting the
// app recreate it reuses the same row. Before the lifecycle stamp the peer's
// surviving tombstone re-deleted the revival on the next exchange.
#[test]
fn revival_beats_an_older_tombstone_on_both_sides() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("14 Sep 2026", "first draft", 1);
    a.copy_to(&b, "14 Sep 2026");

    a.remove("14 Sep 2026", 100);
    b.remove("14 Sep 2026", 100);
    a.revive("14 Sep 2026", 200, "second draft");

    converge(&a, &b);

    assert!(!a.row("14 Sep 2026").is_deleted);
    assert!(!b.row("14 Sep 2026").is_deleted);
    assert_converged(&a, &b);
    assert_eq!(b.text("14 Sep 2026"), "second draft");
}

#[test]
fn a_tombstone_newer_than_a_revival_still_wins() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "content", 1);
    a.copy_row_only(&b, "doc");

    a.revive("doc", 100, "revived");
    b.remove("doc", 300);

    converge(&a, &b);
    assert!(a.row("doc").is_deleted);
    assert!(b.row("doc").is_deleted);
}

#[test]
fn delete_and_revive_in_opposite_orders_converge() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "base", 1);
    a.copy_row_only(&b, "doc");

    a.remove("doc", 500);
    b.revive("doc", 400, "stale revival");

    converge(&a, &b);
    assert!(a.row("doc").is_deleted);
    assert!(b.row("doc").is_deleted);
}

#[test]
fn a_plain_tombstone_still_propagates_to_a_peer_that_has_the_document() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "content", 1);
    a.copy_row_only(&b, "doc");
    a.remove("doc", 100);

    converge(&a, &b);
    assert!(b.row("doc").is_deleted);
}

#[test]
fn rename_race_higher_title_updated_at_wins_on_both_sides() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "x", 10);
    a.copy_to(&b, "doc");
    a.apply_rename("doc", "from-a", 20).unwrap();
    b.apply_rename("doc", "from-b", 30).unwrap();

    converge(&a, &b);
    assert_eq!(a.row("doc").title, "from-b");
    assert_eq!(b.row("doc").title, "from-b");
}

#[test]
fn a_pin_set_on_one_device_reaches_the_other() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "x", 1);
    b.seed("doc", "x", 1);
    a.apply_pin("doc", true, 50).unwrap();

    converge(&a, &b);
    assert!(b.row("doc").pinned);
    assert_eq!(b.row("doc").pinned_updated_at, Some(50));
    assert_converged(&a, &b);
}

// Unpinning is a choice too, and has to travel rather than lose to the pin it
// undid.
#[test]
fn pin_race_the_later_stamp_wins_on_both_sides_even_when_it_unpins() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "x", 1);
    b.seed("doc", "x", 1);
    a.apply_pin("doc", true, 20).unwrap();
    b.apply_pin("doc", false, 30).unwrap();

    converge(&a, &b);
    assert!(!a.row("doc").pinned);
    assert!(!b.row("doc").pinned);
}

#[test]
fn a_note_first_seen_from_a_peer_arrives_pinned() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "x", 1);
    a.apply_pin("doc", true, 50).unwrap();

    converge(&a, &b);
    assert!(b.row("doc").pinned);
    assert_eq!(b.text("doc"), "x");
}

#[test]
fn a_live_pin_applies_when_newer_and_is_ignored_when_older() {
    let a = FakeRepo::default();
    a.seed("doc", "x", 1);
    a.apply_pin("doc", true, 50).unwrap();
    let mut session = Session::new();

    let older = Message::DocPinned {
        id: "doc".into(),
        pinned: false,
        pinned_updated_at: 40,
    };
    session.handle(&a, older, 0);
    assert!(a.row("doc").pinned);

    let newer = Message::DocPinned {
        id: "doc".into(),
        pinned: false,
        pinned_updated_at: 60,
    };
    session.handle(&a, newer, 0);
    assert!(!a.row("doc").pinned);
}

#[test]
fn delete_propagates_to_a_peer_that_still_has_the_document() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("gone", "bye", 1);
    b.seed("gone", "bye", 1);
    a.apply_delete("gone", 100).unwrap();

    converge(&a, &b);
    assert!(b.row("gone").is_deleted);
}

// Three devices, meeting in pairs. C never held the document, so before this
// the tombstone died at C, and B then handed the document back to C.
#[test]
fn a_delete_reaches_a_third_device_through_one_that_never_held_the_document() {
    let (a, b, c) = (
        FakeRepo::default(),
        FakeRepo::default(),
        FakeRepo::default(),
    );
    a.seed("gone", "bye", 1);
    b.seed("gone", "bye", 1);
    a.apply_delete("gone", 100).unwrap();

    converge(&a, &c);
    assert!(c.row("gone").is_deleted);

    converge(&b, &c);
    assert!(b.row("gone").is_deleted);
    assert!(c.row("gone").is_deleted);
}

// Materialising a tombstone as a live row would make the peer pull it and
// leave an untitled empty note on every device.
#[test]
fn a_recorded_tombstone_does_not_resurrect_as_an_empty_document() {
    let (a, c) = (FakeRepo::default(), FakeRepo::default());
    a.seed("gone", "bye", 1);
    a.apply_delete("gone", 100).unwrap();

    converge(&a, &c);
    assert!(c.row("gone").is_deleted);
    assert_eq!(c.text("gone"), "");
}

#[test]
fn reconnect_after_an_offline_edit_transfers_only_the_delta() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "shared", 1);
    a.copy_to(&b, "doc");
    converge(&a, &b);

    b.edit("doc", 6, " MORE");
    b.delta_bytes.set(0);

    let run = converge(&a, &b);
    assert_converged(&a, &b);
    assert_eq!(a.text("doc"), "shared MORE");
    let full = a.row("doc").state.len();
    assert!(b.delta_bytes.get() > 0);
    assert!(b.delta_bytes.get() < full);
    // The side with nothing to send still reaches "synced": it is not left
    // waiting on the other's `sync-need`.
    assert!(run.synced_a && run.synced_b);
}

#[test]
fn a_sync_need_the_holder_cannot_fill_is_answered_with_sync_none() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "base", 1);
    a.copy_to(&b, "doc");
    b.edit("doc", 4, "!");

    let run = converge(&a, &b);
    let a_sent_none = run
        .sent
        .iter()
        .any(|(to_a, m)| !*to_a && matches!(m, Message::SyncNone { .. }));
    assert!(a_sent_none, "A answered rather than going silent");
    assert_eq!(a.text("doc"), "base!");
}

#[test]
fn an_idle_reconnect_of_an_identical_set_is_a_no_op() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "same", 1);
    b.seed("doc", "same", 1);
    converge(&a, &b);

    a.deltas_computed.set(0);
    converge(&a, &b);
    assert_eq!(a.deltas_computed.get(), 0);
}

// ADR 0033, decision 4: empty notes used to be exchanged on every connection.
#[test]
fn two_empty_notes_are_not_exchanged() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("28 Sep 2026", "", 1);
    a.copy_to(&b, "28 Sep 2026");

    converge(&a, &b);
    assert_eq!(a.deltas_computed.get() + b.deltas_computed.get(), 0);
}

#[test]
fn a_peer_pulls_attachment_bytes_it_is_missing() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.add_attachment("abc123", "image/png", b"AAAA".to_vec());
    a.add_attachment("def456", "image/jpeg", b"BBBB".to_vec());
    b.add_attachment("abc123", "image/png", b"AAAA".to_vec());

    converge(&a, &b);
    assert_eq!(
        b.attachment("def456"),
        Some(("image/jpeg".to_string(), b"BBBB".to_vec()))
    );
    assert_eq!(a.attachments.borrow().len(), 2);
}

#[test]
fn attachment_transfer_does_not_block_the_document_finish_gate() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("d1", "hello", 1);
    a.add_attachment("img", "image/png", vec![b'X'; 1000]);

    let run = converge(&a, &b);
    assert!(run.synced_a && run.synced_b);
    assert!(b.attachment("img").is_some());
}

#[test]
fn a_holder_that_lost_the_bytes_answers_attach_missing_without_crashing() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);
    let manifest = Message::AttachManifest {
        items: vec![AttachmentEntry {
            hash: "ghost".into(),
            mime: "image/png".into(),
            size: 1,
        }],
    };
    session.handle(&b, manifest, 0);
    session.handle(
        &b,
        Message::AttachMissing {
            hash: "ghost".into(),
        },
        0,
    );
    assert!(b.attachment("ghost").is_none());
    assert!(!session.has_images_pending());
}

fn ghost_manifest(hash: &str) -> Message {
    Message::AttachManifest {
        items: vec![AttachmentEntry {
            hash: hash.into(),
            mime: "image/png".into(),
            size: 1,
        }],
    }
}

fn needs(outs: &[Out]) -> usize {
    sends(outs)
        .iter()
        .filter(|m| matches!(m, Message::AttachNeed { .. }))
        .count()
}

// The retry counter used to live in the in-flight map, which a timeout cleared
// before requeueing, so the attempt limit was unreachable and a silent peer
// was polled every 30s for the life of the connection.
#[test]
fn gives_up_on_an_attachment_after_the_attempt_limit() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);

    let first = session.handle(&b, ghost_manifest("ghost"), 0);
    assert_eq!(needs(&first), 1);

    let t = ATTACH_TIMEOUT_MS + 1;
    assert_eq!(needs(&session.tick(t)), 1);
    assert_eq!(needs(&session.tick(2 * t)), 0);
    assert_eq!(needs(&session.tick(3 * t)), 0);
    assert!(!session.has_images_pending());
}

#[test]
fn a_retried_attachment_still_lands_if_the_peer_answers_late() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);
    session.handle(&b, ghost_manifest("slow"), 0);
    session.tick(ATTACH_TIMEOUT_MS + 1);

    let late = Message::AttachPiece {
        hash: "slow".into(),
        mime: "image/png".into(),
        offset: 0,
        total: 4,
        data: b"ZZZZ".to_vec(),
    };
    session.handle(&b, late, ATTACH_TIMEOUT_MS + 2);
    assert_eq!(
        b.attachment("slow"),
        Some(("image/png".to_string(), b"ZZZZ".to_vec()))
    );
}

// --- what changed ----------------------------------------------------------

// ADR 0031, decision 2: a side with nothing to pull used to report synced as
// soon as the other said what it would pull, while that side was still
// pulling from it. A background run that stopped then would leave the
// desktop without the phone's notes.
#[test]
fn a_side_is_not_synced_while_the_other_is_still_pulling_from_it() {
    let (phone, desktop) = (FakeRepo::default(), FakeRepo::default());
    for i in 0..10 {
        phone.seed(&format!("note {i}"), "written on the phone", 1);
    }
    let mut sp = Session::new();
    let mut sd = Session::new();
    let mut to_phone = VecDeque::new();
    let mut to_desktop = VecDeque::new();
    let mut phone_synced = false;
    let mut desktop_synced = false;

    route_to(sp.start(&phone, 0), &mut to_desktop, &mut phone_synced);
    route_to(sd.start(&desktop, 0), &mut to_phone, &mut desktop_synced);

    // Deliver everything, but keep each side's view of its own `synced`
    // honest after every step: the phone must not be synced while the desktop
    // still has pulls in flight.
    let mut guard = 0;
    while !to_phone.is_empty() || !to_desktop.is_empty() {
        guard += 1;
        assert!(guard < 10_000);
        if let Some(msg) = to_desktop.pop_front() {
            route_to(
                sd.handle(&desktop, msg, 0),
                &mut to_phone,
                &mut desktop_synced,
            );
        }
        if let Some(msg) = to_phone.pop_front() {
            route_to(
                sp.handle(&phone, msg, 0),
                &mut to_desktop,
                &mut phone_synced,
            );
        }
        if phone_synced {
            assert!(
                (0..10).all(|i| desktop.text(&format!("note {i}")) == "written on the phone"),
                "the phone reported synced before the desktop had every note"
            );
        }
    }
    assert!(phone_synced && desktop_synced);
}

fn route_to(outs: Vec<Out>, queue: &mut VecDeque<Message>, synced: &mut bool) {
    for out in outs {
        match out {
            Out::Send(msg) => queue.push_back(msg),
            Out::Synced { .. } => *synced = true,
            _ => {}
        }
    }
}

#[test]
fn a_large_image_travels_in_pieces_and_arrives_whole() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    let photo: Vec<u8> = (0..(PIECE_BYTES * 2 + 1000))
        .map(|i| (i % 251) as u8)
        .collect();
    a.add_attachment("photo", "image/jpeg", photo.clone());

    let run = converge(&a, &b);
    let pieces = run
        .sent
        .iter()
        .filter(|(_, m)| matches!(m, Message::AttachPiece { .. }))
        .count();
    assert_eq!(pieces, 3);
    assert_eq!(
        b.attachment("photo"),
        Some(("image/jpeg".to_string(), photo))
    );
}

#[test]
fn pieces_arriving_keep_a_slow_transfer_alive_past_its_first_deadline() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);
    session.handle(&b, ghost_manifest("slow"), 0);

    let piece = |offset: u64, data: &[u8]| Message::AttachPiece {
        hash: "slow".into(),
        mime: "image/png".into(),
        offset,
        total: 4,
        data: data.to_vec(),
    };
    // Half arrives just before the first deadline, which then moves on.
    session.handle(&b, piece(0, b"ZZ"), ATTACH_TIMEOUT_MS - 1);
    let retried = session.tick(ATTACH_TIMEOUT_MS + 1);
    assert_eq!(needs(&retried), 0, "not asked again while pieces arrive");

    session.handle(&b, piece(2, b"ZZ"), ATTACH_TIMEOUT_MS + 5);
    assert_eq!(b.attachment("slow").map(|(_, d)| d), Some(b"ZZZZ".to_vec()));
}

#[test]
fn a_piece_claiming_an_image_over_the_limit_is_refused() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);
    let huge = Message::AttachPiece {
        hash: "huge".into(),
        mime: "image/png".into(),
        offset: 0,
        total: MAX_IMAGE_BYTES + 1,
        data: vec![0; 10],
    };
    session.handle(&b, huge, 0);
    assert!(b.attachment("huge").is_none());
}

#[test]
fn a_piece_out_of_order_is_dropped_rather_than_stored_wrong() {
    let b = FakeRepo::default();
    let mut session = Session::new();
    session.start(&b, 0);
    session.handle(&b, ghost_manifest("img"), 0);
    let piece = |offset: u64| Message::AttachPiece {
        hash: "img".into(),
        mime: "image/png".into(),
        offset,
        total: 6,
        data: b"AB".to_vec(),
    };
    session.handle(&b, piece(0), 1);
    session.handle(&b, piece(4), 2);
    session.handle(&b, piece(2), 3);
    assert!(b.attachment("img").is_none());
}

#[test]
fn the_next_deadline_is_the_earliest_pull_in_flight() {
    let (a, b) = (FakeRepo::default(), FakeRepo::default());
    a.seed("doc", "x", 1);
    let mut sb = Session::new();
    sb.start(&b, 0);
    let manifest = Message::SyncManifest {
        docs: a.list_sync_state().unwrap(),
    };
    sb.handle(&b, manifest, 100);
    assert_eq!(sb.next_deadline(), Some(100 + NEED_TIMEOUT_MS));
}
