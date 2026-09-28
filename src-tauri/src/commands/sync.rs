use crate::crdt;
use crate::db::AppState;
use crate::indexer;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

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
}

#[tauri::command]
pub fn get_yjs_state(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<YjsStateResult, String> {
    trace!("[cmd] get_yjs_state doc_id={}", doc_id);
    let state_vec: Vec<u8> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        // Two legitimately empty cases: no such row (missing or tombstoned),
        // and a row that has no content yet. A query that actually failed is
        // not one of them. Collapsing all three into "empty document" meant a
        // transient SQLITE_BUSY read as an empty document, which the editor
        // then saved back over the real content.
        .optional()
        .map_err(|e| format!("failed to read state for {doc_id}: {e}"))?
        .flatten()
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
    })
}

/// Where a Yjs update came from, which decides whether the editor is told to
/// reload the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateOrigin {
    /// The editor's own save. It already has this content in its ydoc.
    Local,
    /// Merged from a peer. An open editor has to be told.
    Remote,
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

    let merged = crdt::merge(stored.as_deref().unwrap_or_default(), update)
        .map_err(|e| format!("could not merge into {doc_id}: {e}"))?;
    db.execute(
        "UPDATE documents SET crdt_state = ?1, content_hash = ?2, updated_at = ?3
          WHERE id = ?4 AND is_deleted = 0",
        params![
            &merged.state,
            merged.content_hash.map(|h| h.to_vec()),
            now,
            doc_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(merged))
}

#[tauri::command]
pub async fn save_yjs_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: String,
    origin: UpdateOrigin,
    // What the editor extracted from the document: text for search, link
    // targets, todo counts. Absent when the caller could not render it.
    index: Option<indexer::DocumentIndexInput>,
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

    // Only a peer's update needs to reach an open editor. This used to fire on
    // every save, including the editor's own: the editor listened, saw its own
    // document id, and pulled the entire document back over IPC to apply state
    // it had just produced. Idempotent in Yjs terms, and pure waste that grew
    // with document size.
    if origin == UpdateOrigin::Remote {
        let _ = state
            .app_handle
            .emit("sync-received", serde_json::json!({ "doc_id": doc_id }));
    }

    Ok(SavedState {
        state_vector: merged
            .map(|m| BASE64.encode(m.state_vector))
            .unwrap_or_default(),
    })
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
