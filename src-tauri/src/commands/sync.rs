use crate::crdt;
use crate::db::AppState;
use crate::indexer;
use crate::sync::protocol::Message;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

// Yjs state crosses the IPC boundary as base64 rather than a JSON array of
// numbers. A number array serialises to roughly 3.6 bytes of JSON per byte of
// payload; base64 is 1.33. On a document of any size this was the dominant cost
// of a save.
fn decode(field: &str, value: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(value)
        .map_err(|e| format!("{field} is not valid base64: {e}"))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct YjsStateResult {
    pub doc_id: String,
    /// base64 of the merged Yjs state; empty string when there is none.
    pub state: String,
    /// base64 of the stored content hash, so an index read from this state
    /// can say which state it was read from (`save_document_index`).
    pub content_hash: Option<String>,
}

#[tauri::command]
pub fn get_yjs_state(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<YjsStateResult, String> {
    trace!("[cmd] get_yjs_state doc_id={}", doc_id);
    let (state_vec, hash): (Vec<u8>, Option<Vec<u8>>) = {
        let db = state.db.lock();
        db.query_row(
            "SELECT crdt_state, content_hash FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| {
                Ok((
                    row.get::<_, Option<Vec<u8>>>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                ))
            },
        )
        // Two legitimately empty cases: no such row (missing or tombstoned),
        // and a row that has no content yet. A query that actually failed is
        // not one of them. Collapsing all three into "empty document" meant a
        // transient SQLITE_BUSY read as an empty document, which the editor
        // then saved back over the real content.
        .optional()
        .map_err(|e| format!("failed to read state for {doc_id}: {e}"))?
        .map(|(state, hash)| (state.unwrap_or_default(), hash))
        .unwrap_or_default()
    };
    trace!(
        "[cmd] get_yjs_state doc_id={} -> {} bytes",
        doc_id,
        state_vec.len()
    );
    Ok(YjsStateResult {
        doc_id,
        state: BASE64.encode(&state_vec),
        content_hash: hash.map(|h| BASE64.encode(h)),
    })
}

/// What the store holds after a save, for the editor's next one.
#[derive(Debug, Serialize)]
pub struct SavedState {
    /// base64 of the stored state vector. The editor sends its next save as
    /// the update the store is missing against it (ADR 0031, decision 4).
    /// Empty when there was no live row to save into.
    pub state_vector: String,
}

/// Merge `update` into a document's stored state, and hash the result.
///
/// The one place `crdt_state` changes content. It used to be overwritten
/// with whatever merged state the webview computed, which was only safe while
/// the webview was the one writer: with two, each would erase the other's
/// update. A merge cannot, since applying an update the state already holds
/// changes nothing (ADR 0031, decision 3).
///
/// Runs under the caller's database lock, so a read, merge and write to one
/// document cannot interleave with another. Returns `None` when the document
/// is missing or deleted, which is not an error: a peer's update for a note
/// deleted here has nowhere to go.
pub fn merge_into_document(
    db: &rusqlite::Connection,
    doc_id: &str,
    update: &[u8],
    now: i64,
) -> Result<Option<crdt::Merged>, String> {
    let stored: Option<Option<Vec<u8>>> = db
        .query_row(
            "SELECT crdt_state FROM documents WHERE id = ?1 AND is_deleted = 0",
            params![doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to read state for {doc_id}: {e}"))?;
    let Some(stored) = stored else {
        return Ok(None);
    };

    let stored = stored.unwrap_or_default();
    let merged =
        crdt::merge(&stored, update).map_err(|e| format!("could not merge into {doc_id}: {e}"))?;
    let hash = merged.content_hash.map(|h| h.to_vec());
    let written = if merged.delta.is_some() {
        db.execute(
            "UPDATE documents SET crdt_state = ?1, content_hash = ?2, updated_at = ?3
              WHERE id = ?4 AND is_deleted = 0",
            params![&merged.state, hash, now, doc_id],
        )
    } else if merged.state != stored {
        // Nothing anyone could see changed, so the document was not edited:
        // an update still waiting on another, or the state as yrs encodes it.
        db.execute(
            "UPDATE documents SET crdt_state = ?1, content_hash = ?2
              WHERE id = ?3 AND is_deleted = 0",
            params![&merged.state, hash, doc_id],
        )
    } else {
        Ok(0)
    };
    written.map_err(|e| e.to_string())?;
    Ok(Some(merged))
}

/// Save a change made on this device, and tell connected devices what it
/// added (ADR 0031, decision 6). A peer's changes never come through here:
/// the engine merges those itself.
#[tauri::command]
pub async fn save_yjs_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: String,
    // What the editor extracted from the document: text for search, link
    // targets, todo counts. Absent when the caller could not render it.
    index: Option<indexer::DocumentIndexInput>,
    // Saved without telling peers: an imported note's content, which they
    // pull when the note is announced with the rest of its batch (ADR 0029).
    quiet: Option<bool>,
) -> Result<SavedState, String> {
    let update = decode("update", &update)?;
    trace!(
        "[cmd] save_yjs_update doc_id={} update={} bytes",
        doc_id,
        update.len()
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let merged = {
        let db = state.db.lock();
        let merged = merge_into_document(&db, &doc_id, &update, now)?;
        let title: String = db
            .query_row(
                "SELECT title FROM documents WHERE id = ? AND is_deleted = 0",
                params![&doc_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        match &index {
            Some(index) => indexer::update_document_index(&db, &doc_id, &title, index)?,
            None => indexer::update_document_title(&db, &doc_id, &title)?,
        }
        merged
    };

    let Some(merged) = merged else {
        return Ok(SavedState {
            state_vector: String::new(),
        });
    };
    // What the save added, not what it was handed: the page sends whatever
    // the store might be missing, which can include a peer's edit the store
    // already has, and sending that back would echo it.
    if let (Some(delta), false) = (merged.delta, quiet.unwrap_or(false)) {
        crate::sync::announce(
            &state.app_handle,
            Message::LiveUpdate {
                id: doc_id,
                update: delta,
            },
        );
    }
    Ok(SavedState {
        state_vector: BASE64.encode(merged.state_vector),
    })
}

/// Record what the page read out of a document (ADR 0031, decision 7). The
/// engine merges a peer's update but cannot render the result, so the
/// document waits at `index_version = 0` until the page has.
///
/// `content_hash` names the state the index was read from, when the page
/// read it from the store. An index read from a state the document has since
/// moved on from is dropped: the change that moved it brings its own turn,
/// and a stale index marked current would never be redone. Without one, the
/// index is taken as it is. Returns whether it was written.
#[tauri::command]
pub fn save_document_index(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    index: indexer::DocumentIndexInput,
    content_hash: Option<String>,
) -> Result<bool, String> {
    let db = state.db.lock();
    write_index(&db, &doc_id, &index, content_hash.as_deref())
}

pub fn write_index(
    db: &rusqlite::Connection,
    doc_id: &str,
    index: &indexer::DocumentIndexInput,
    read_from: Option<&str>,
) -> Result<bool, String> {
    let row: Option<(String, Option<Vec<u8>>)> = db
        .query_row(
            "SELECT title, content_hash FROM documents WHERE id = ?1 AND is_deleted = 0",
            params![doc_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((title, stored)) = row else {
        return Ok(false);
    };
    if let Some(read_from) = read_from {
        if stored.map(|h| BASE64.encode(h)).as_deref() != Some(read_from) {
            return Ok(false);
        }
    }
    indexer::update_document_index(db, doc_id, &title, index)?;
    Ok(true)
}

/// Give every document without a content hash one, a row at a time (ADR
/// 0033, decision 5).
///
/// The v13 migration clears the hashes the webview used to write, since the
/// new hash matches none of them. Rebuilding them there would put the app's
/// start at the mercy of any one document `yrs` cannot read, so it happens
/// here, off the startup path. Each row is read, hashed without the lock, and
/// written only if its state is still what was hashed: a save in between has
/// written its own. A row that cannot be read, or holds updates it cannot
/// apply yet, keeps no hash and is exchanged like any unknown.
pub fn rehash_documents(db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>) {
    let mut after = String::new();
    let mut hashed = 0usize;
    loop {
        let next: Option<(String, Vec<u8>)> = {
            let db = db.lock();
            db.query_row(
                "SELECT id, crdt_state FROM documents
                  WHERE content_hash IS NULL AND is_deleted = 0
                    AND crdt_state IS NOT NULL AND length(crdt_state) > ?1
                    AND id > ?2
                  ORDER BY id LIMIT 1",
                params![crdt::EMPTY_UPDATE_LEN as i64, &after],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap_or_else(|e| {
                warn_log!("[sync] could not look for documents to hash: {e}");
                None
            })
        };
        let Some((id, crdt_state)) = next else {
            break;
        };
        match crdt::hash_state(&crdt_state) {
            Ok(Some(hash)) => {
                let db = db.lock();
                match db.execute(
                    "UPDATE documents SET content_hash = ?1
                      WHERE id = ?2 AND crdt_state = ?3 AND content_hash IS NULL",
                    params![hash.to_vec(), &id, &crdt_state],
                ) {
                    Ok(_) => hashed += 1,
                    Err(e) => warn_log!("[sync] could not store the hash of {id}: {e}"),
                }
            }
            Ok(None) => trace!("[sync] {id} holds updates it cannot apply yet, left unhashed"),
            Err(e) => warn_log!("[sync] could not hash {id}, it will be exchanged: {e}"),
        }
        after = id;
    }
    if hashed > 0 {
        trace!("[sync] hashed {hashed} document(s)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn library() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::setup_database_tables(&db).unwrap();
        crate::run_migrations(&db).unwrap();
        db
    }

    fn add(db: &Connection, id: &str, state: Option<&[u8]>) {
        db.execute(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
             VALUES (?1, 'note', ?1, ?2, 0, 0)",
            params![id, state],
        )
        .unwrap();
    }

    fn written(client: u64, text: &str) -> Vec<u8> {
        use yrs::{Doc, ReadTxn, StateVector, Text, Transact};
        let doc = Doc::with_client_id(client);
        let body = doc.get_or_insert_text("body");
        body.insert(&mut doc.transact_mut(), 0, text);
        let state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        state
    }

    fn stored(db: &Connection, id: &str) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        db.query_row(
            "SELECT crdt_state, content_hash FROM documents WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_save_merges_rather_than_overwrites() {
        let db = library();
        add(&db, "d", None);
        merge_into_document(&db, "d", &written(1, "one"), 1).unwrap();
        merge_into_document(&db, "d", &written(2, "two"), 2).unwrap();

        let (state, hash) = stored(&db, "d");
        let both = crdt::merge(&written(1, "one"), &written(2, "two")).unwrap();
        assert_eq!(hash, both.content_hash.map(|h| h.to_vec()));
        assert_eq!(
            crdt::hash_state(&state.unwrap()).unwrap(),
            both.content_hash
        );
    }

    #[test]
    fn a_save_to_a_deleted_or_missing_document_does_nothing() {
        let db = library();
        add(&db, "gone", None);
        db.execute("UPDATE documents SET is_deleted = 1", [])
            .unwrap();
        assert!(merge_into_document(&db, "gone", &written(1, "x"), 1)
            .unwrap()
            .is_none());
        assert!(merge_into_document(&db, "never", &written(1, "x"), 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn an_update_that_cannot_be_read_is_refused_and_nothing_is_written() {
        let db = library();
        add(&db, "d", Some(&written(1, "kept")));
        assert!(merge_into_document(&db, "d", &[9, 9, 9, 9], 1).is_err());
        assert_eq!(stored(&db, "d").0, Some(written(1, "kept")));
    }

    fn hash_of(db: &Connection, id: &str) -> String {
        BASE64.encode(stored(db, id).1.unwrap())
    }

    fn index(text: &str) -> indexer::DocumentIndexInput {
        indexer::DocumentIndexInput {
            text: text.to_string(),
            ..Default::default()
        }
    }

    fn indexed_text(db: &Connection, id: &str) -> Option<String> {
        db.query_row(
            "SELECT body FROM document_search WHERE document_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn an_index_read_from_the_stored_state_is_written() {
        let db = library();
        add(&db, "d", None);
        merge_into_document(&db, "d", &written(1, "one"), 1).unwrap();
        let read_from = hash_of(&db, "d");

        assert!(write_index(&db, "d", &index("one"), Some(&read_from)).unwrap());
        assert_eq!(indexed_text(&db, "d").as_deref(), Some("one"));
    }

    // ADR 0031, decision 7: a merge landed after the page read the document,
    // so what it rendered is already out of date, and marking it current
    // would keep it that way.
    #[test]
    fn an_index_read_from_a_state_the_document_has_moved_on_from_is_dropped() {
        let db = library();
        add(&db, "d", None);
        merge_into_document(&db, "d", &written(1, "one"), 1).unwrap();
        let read_from = hash_of(&db, "d");
        merge_into_document(&db, "d", &written(2, "two"), 2).unwrap();

        assert!(!write_index(&db, "d", &index("one"), Some(&read_from)).unwrap());
        assert_eq!(indexed_text(&db, "d"), None);
    }

    #[test]
    fn an_index_from_the_open_document_is_taken_as_it_is() {
        let db = library();
        add(&db, "d", Some(&written(1, "one")));
        assert!(write_index(&db, "d", &index("one"), None).unwrap());
        assert!(!write_index(&db, "gone", &index("x"), None).unwrap());
    }

    #[test]
    fn a_save_that_changes_nothing_leaves_the_document_unedited() {
        let db = library();
        add(&db, "d", None);
        merge_into_document(&db, "d", &written(1, "one"), 5).unwrap();

        let again = merge_into_document(&db, "d", &written(1, "one"), 9)
            .unwrap()
            .unwrap();

        assert!(again.delta.is_none());
        let updated_at: i64 = db
            .query_row("SELECT updated_at FROM documents WHERE id = 'd'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(updated_at, 5);
    }

    #[test]
    fn rehashing_fills_in_every_hash_it_can() {
        let db = std::sync::Arc::new(parking_lot::Mutex::new(library()));
        {
            let db = db.lock();
            add(&db, "a", Some(&written(1, "a")));
            add(&db, "b", Some(&written(2, "b")));
            add(&db, "broken", Some(&[7, 7, 7, 7]));
            add(&db, "empty", None);
        }
        rehash_documents(&db);

        let db = db.lock();
        assert_eq!(
            stored(&db, "a").1,
            crdt::hash_state(&written(1, "a"))
                .unwrap()
                .map(|h| h.to_vec())
        );
        assert!(stored(&db, "b").1.is_some());
        assert_eq!(stored(&db, "broken").1, None);
        assert_eq!(stored(&db, "empty").1, None);
    }
}
