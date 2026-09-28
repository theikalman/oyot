//! The session's repository, on this device's database (ADR 0031).
//!
//! Takes the database and the data directory rather than the app's state, so
//! it works in a phone's background run, where there is no Tauri app (ADR
//! 0031, decision 8). Everything it changes goes through the functions the
//! commands already use, so a peer's change and the user's cannot follow
//! different rules.

use super::events::Events;
use super::protocol::{lifecycle_stamp, AttachmentEntry, ManifestEntry};
use super::session::Repo;
use crate::commands::attachments;
use crate::commands::documents::{self, EnsureDocumentRequest};
use crate::commands::sync::merge_into_document;
use crate::crdt;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

pub struct SqliteRepo {
    db: Arc<Mutex<Connection>>,
    data_dir: PathBuf,
    events: Arc<dyn Events>,
}

impl SqliteRepo {
    pub fn new(db: Arc<Mutex<Connection>>, data_dir: PathBuf, events: Arc<dyn Events>) -> Self {
        Self {
            db,
            data_dir,
            events,
        }
    }

    /// The stored state of a live document; empty for none, or for a
    /// tombstone, whose content is gone.
    fn state_of(&self, id: &str) -> Result<Vec<u8>, String> {
        let db = self.db.lock();
        let state: Option<Option<Vec<u8>>> = db
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = ?1 AND is_deleted = 0",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("failed to read state for {id}: {e}"))?;
        Ok(state.flatten().unwrap_or_default())
    }
}

fn now_ms() -> i64 {
    crate::crypto::now_ms()
}

fn request(entry: &ManifestEntry) -> EnsureDocumentRequest {
    EnsureDocumentRequest {
        doc_id: entry.id.clone(),
        doc_type: entry.doc_type.clone(),
        title: entry.title.clone(),
        created_at: entry.created_at,
        updated_at: entry.title_updated_at,
        title_updated_at: Some(entry.title_updated_at),
        lifecycle_updated_at: Some(lifecycle_stamp(entry)),
        deleted_at: entry.deleted_at,
        pinned: entry.pinned.unwrap_or(false),
        pinned_updated_at: entry.pinned_updated_at,
    }
}

fn load(state: &[u8]) -> Result<Doc, String> {
    let doc = Doc::new();
    if state.len() > crdt::EMPTY_UPDATE_LEN {
        let update = Update::decode_v1(state).map_err(|e| e.to_string())?;
        doc.transact_mut()
            .apply_update(update)
            .map_err(|e| e.to_string())?;
    }
    Ok(doc)
}

/// A row as a manifest describes it to a peer.
pub fn manifest_entry(r: documents::DocSyncEntry) -> ManifestEntry {
    ManifestEntry {
        id: r.id,
        doc_type: r.doc_type,
        title: r.title,
        title_updated_at: r.title_updated_at,
        created_at: r.created_at,
        is_deleted: r.is_deleted,
        deleted_at: r.deleted_at,
        lifecycle_updated_at: Some(r.lifecycle_updated_at),
        pinned: Some(r.pinned),
        pinned_updated_at: r.pinned_updated_at,
        content_hash: r.content_hash,
    }
}

impl Repo for SqliteRepo {
    fn list_sync_state(&self) -> Result<Vec<ManifestEntry>, String> {
        let rows = documents::query_sync_state(&self.db.lock())?;
        Ok(rows.into_iter().map(manifest_entry).collect())
    }

    fn ensure_doc(&self, entry: &ManifestEntry) -> Result<(), String> {
        documents::ensure_row(&self.db.lock(), &request(entry))?;
        self.events.doc_created(entry);
        Ok(())
    }

    fn ensure_tombstone(&self, entry: &ManifestEntry) -> Result<(), String> {
        documents::insert_tombstone(&self.db.lock(), &request(entry))?;
        Ok(())
    }

    fn apply_rename(&self, id: &str, title: &str, at: i64) -> Result<bool, String> {
        let changed = documents::apply_rename_if_newer(&self.db.lock(), id, title, at)?;
        if changed {
            self.events.doc_renamed(id, title, at);
        }
        Ok(changed)
    }

    fn apply_pin(&self, id: &str, pinned: bool, at: i64) -> Result<bool, String> {
        let changed = documents::apply_pin_if_newer(&self.db.lock(), id, pinned, at)?;
        if changed {
            self.events.doc_pinned(id, pinned, at);
        }
        Ok(changed)
    }

    fn apply_delete(&self, id: &str, deleted_at: i64) -> Result<bool, String> {
        let applied = documents::apply_tombstone_if_newer(&self.db.lock(), id, deleted_at)?;
        if applied {
            self.events.doc_deleted(id);
        }
        Ok(applied)
    }

    fn local_state_vector(&self, id: &str) -> Result<Vec<u8>, String> {
        let state = self.state_of(id)?;
        let sv = load(&state)?.transact().state_vector().encode_v1();
        Ok(sv)
    }

    fn compute_delta(&self, id: &str, sv: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let state = self.state_of(id)?;
        if state.len() <= crdt::EMPTY_UPDATE_LEN {
            return Ok(None);
        }
        let since = if sv.is_empty() {
            StateVector::default()
        } else {
            StateVector::decode_v1(sv).map_err(|e| format!("an unreadable state vector: {e}"))?
        };
        let diff = load(&state)?.transact().encode_state_as_update_v1(&since);
        Ok((diff.len() > crdt::EMPTY_UPDATE_LEN).then_some(diff))
    }

    /// Merge a peer's update into the stored state (ADR 0031, decision 3),
    /// and leave the document for the page to re-index (decision 7): only the
    /// page can render it, so until it has, it is `index_version = 0`, which
    /// also keeps attachment collection waiting (ADR 0013).
    fn merge_delta(&self, id: &str, update: &[u8]) -> Result<(), String> {
        let delta = {
            let db = self.db.lock();
            let delta = merge_into_document(&db, id, update, now_ms())?.and_then(|m| m.delta);
            if delta.is_some() {
                db.execute(
                    "UPDATE documents SET index_version = 0 WHERE id = ?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
            }
            delta
        };
        // Only what the update added: one that changed nothing here, an echo
        // or a repeat, is nothing for the page to apply or index.
        if let Some(delta) = delta {
            self.events.doc_merged(id, &delta);
        }
        Ok(())
    }

    fn list_attachments(&self) -> Result<Vec<AttachmentEntry>, String> {
        Ok(attachments::attachment_manifest(&self.db, &self.data_dir)?
            .into_iter()
            .map(|a| AttachmentEntry {
                hash: a.hash,
                mime: a.mime_type,
                size: a.size.max(0) as u64,
            })
            .collect())
    }

    fn has_attachment(&self, hash: &str) -> Result<bool, String> {
        attachments::has_attachment(&self.db.lock(), hash)
    }

    fn read_attachment(&self, hash: &str) -> Result<Option<(String, Vec<u8>)>, String> {
        attachments::read_attachment_bytes(&self.db, &self.data_dir, hash)
    }

    /// Held to its hash, then stored with the checks every image gets: the
    /// size cap, and the type read from the bytes.
    fn save_attachment(&self, hash: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
        let actual = attachments::sha256_hex(bytes);
        if actual != hash {
            return Err(format!(
                "attachment hash mismatch: expected {hash}, got {actual}"
            ));
        }
        attachments::store_attachment_at(&self.db, &self.data_dir, bytes, mime)?;
        self.events.attachment_downloaded(hash);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::session::{Out, Session};
    use std::collections::VecDeque;
    use yrs::{GetString, Text};

    /// Records what the page would be told.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    impl Events for Recorder {
        fn doc_created(&self, entry: &ManifestEntry) {
            self.0.lock().push(format!("created {}", entry.id));
        }
        fn doc_renamed(&self, id: &str, title: &str, _: i64) {
            self.0.lock().push(format!("renamed {id} {title}"));
        }
        fn doc_deleted(&self, id: &str) {
            self.0.lock().push(format!("deleted {id}"));
        }
        fn doc_merged(&self, id: &str, _: &[u8]) {
            self.0.lock().push(format!("merged {id}"));
        }
        fn attachment_downloaded(&self, hash: &str) {
            self.0.lock().push(format!("downloaded {hash}"));
        }
    }

    struct Device {
        repo: SqliteRepo,
        db: Arc<Mutex<Connection>>,
        events: Arc<Recorder>,
        dir: PathBuf,
    }

    impl Drop for Device {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn device(name: &str) -> Device {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        let db = Arc::new(Mutex::new(db));
        let dir = std::env::temp_dir().join(format!("oyot-repo-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let events = Arc::new(Recorder::default());
        Device {
            repo: SqliteRepo::new(db.clone(), dir.clone(), events.clone()),
            db,
            events,
            dir,
        }
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

    fn write_note(device: &Device, id: &str, text: &str) {
        let db = device.db.lock();
        documents::insert_document(&db, id, "note", id, false, 10).unwrap();
        merge_into_document(&db, id, &state_with(text), 10).unwrap();
    }

    fn text_of(device: &Device, id: &str) -> String {
        let doc = load(&device.repo.state_of(id).unwrap()).unwrap();
        let body = doc.get_or_insert_text("content");
        let text = body.get_string(&doc.transact());
        text
    }

    fn index_version(device: &Device, id: &str) -> i64 {
        device
            .db
            .lock()
            .query_row(
                "SELECT index_version FROM documents WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// Two devices' sessions over their own databases, until quiet.
    fn converge(a: &Device, b: &Device) -> (bool, bool) {
        let mut sa = Session::new();
        let mut sb = Session::new();
        let mut queue: VecDeque<(bool, crate::sync::protocol::Message)> = VecDeque::new();
        let mut synced = (false, false);
        let push = |outs: Vec<Out>, to_a: bool, queue: &mut VecDeque<_>, s: &mut bool| {
            for out in outs {
                match out {
                    Out::Send(m) => queue.push_back((to_a, m)),
                    Out::Synced { .. } => *s = true,
                    _ => {}
                }
            }
        };
        push(sa.start(&a.repo, 0), false, &mut queue, &mut synced.0);
        push(sb.start(&b.repo, 0), true, &mut queue, &mut synced.1);
        let mut guard = 0;
        while let Some((to_a, msg)) = queue.pop_front() {
            guard += 1;
            assert!(guard < 10_000);
            if to_a {
                let outs = sa.handle(&a.repo, msg, 0);
                push(outs, false, &mut queue, &mut synced.0);
            } else {
                let outs = sb.handle(&b.repo, msg, 0);
                push(outs, true, &mut queue, &mut synced.1);
            }
        }
        synced
    }

    #[test]
    fn two_databases_converge_through_their_sessions() {
        let (a, b) = (device("a"), device("b"));
        write_note(&a, "groceries", "milk, eggs");
        write_note(&b, "todo", "call mum");

        assert_eq!(converge(&a, &b), (true, true));
        assert_eq!(text_of(&b, "groceries"), "milk, eggs");
        assert_eq!(text_of(&a, "todo"), "call mum");

        // And once converged, the manifests agree, hashes included.
        let strip = |mut rows: Vec<ManifestEntry>| {
            rows.sort_by(|x, y| x.id.cmp(&y.id));
            rows.into_iter()
                .map(|r| (r.id, r.content_hash, r.is_deleted))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            strip(a.repo.list_sync_state().unwrap()),
            strip(b.repo.list_sync_state().unwrap())
        );
    }

    #[test]
    fn a_merged_document_waits_for_the_page_to_index_it_and_the_page_is_told() {
        let (a, b) = (device("a"), device("b"));
        write_note(&a, "doc", "from a");
        converge(&a, &b);

        assert_eq!(index_version(&b, "doc"), 0);
        let told = b.events.0.lock().clone();
        assert!(told.contains(&"created doc".to_string()), "{told:?}");
        assert!(told.contains(&"merged doc".to_string()), "{told:?}");
        assert!(
            !crate::commands::attachments::unindexed_document_ids(&b.db.lock())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_rename_and_a_delete_reach_the_other_database_and_the_page() {
        let (a, b) = (device("a"), device("b"));
        write_note(&a, "doc", "x");
        converge(&a, &b);

        a.repo.apply_rename("doc", "Renamed", 1_000).unwrap();
        converge(&a, &b);
        assert!(b
            .events
            .0
            .lock()
            .contains(&"renamed doc Renamed".to_string()));

        a.repo.apply_delete("doc", 2_000).unwrap();
        converge(&a, &b);
        let rows = b.repo.list_sync_state().unwrap();
        assert!(rows.iter().any(|r| r.id == "doc" && r.is_deleted));
        assert!(b.events.0.lock().contains(&"deleted doc".to_string()));
    }

    #[test]
    fn nothing_is_computed_for_a_tombstone() {
        let a = device("a");
        write_note(&a, "doc", "x");
        a.repo.apply_delete("doc", 2_000).unwrap();
        assert_eq!(a.repo.compute_delta("doc", &[]).unwrap(), None);
        assert_eq!(a.repo.state_of("doc").unwrap(), Vec::<u8>::new());
    }

    // The smallest PNG there is: the type check reads the signature.
    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0; 32]);
        bytes
    }

    #[test]
    fn an_image_is_stored_only_under_its_own_hash() {
        let a = device("a");
        let bytes = png();
        let hash = attachments::sha256_hex(&bytes);

        assert!(a.repo.save_attachment("0000", "image/png", &bytes).is_err());
        assert!(!a.repo.has_attachment(&hash).unwrap());

        a.repo.save_attachment(&hash, "image/png", &bytes).unwrap();
        assert!(a.repo.has_attachment(&hash).unwrap());
        assert_eq!(
            a.repo.read_attachment(&hash).unwrap(),
            Some(("image/png".to_string(), bytes))
        );
        assert!(a.events.0.lock().contains(&format!("downloaded {hash}")));
    }

    #[test]
    fn an_image_that_is_not_one_is_refused() {
        let a = device("a");
        let bytes = b"not an image at all".to_vec();
        let hash = attachments::sha256_hex(&bytes);
        assert!(a.repo.save_attachment(&hash, "image/png", &bytes).is_err());
    }
}
