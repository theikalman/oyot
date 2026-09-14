use crate::db::AppState;
use crate::indexer;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct YjsStateResult {
    pub doc_id: String,
    pub state: Vec<u8>,
}

#[tauri::command]
pub fn get_yjs_state(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<YjsStateResult, String> {
    eprintln!("[cmd] get_yjs_state doc_id={}", doc_id);
    let state_vec: Vec<u8> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };
    eprintln!(
        "[cmd] get_yjs_state doc_id={} -> {} bytes",
        doc_id,
        state_vec.len()
    );
    Ok(YjsStateResult {
        doc_id,
        state: state_vec,
    })
}

#[tauri::command]
pub async fn save_yjs_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: Vec<u8>,
    merged_state: Vec<u8>,
    content_hash: Option<Vec<u8>>,
) -> Result<(), String> {
    eprintln!(
        "[cmd] save_yjs_update doc_id={} update={} bytes merged_state={} bytes",
        doc_id,
        update.len(),
        merged_state.len()
    );
    let db_snapshot = state.snapshot.clone();
    db_snapshot.append_update(&doc_id, &update)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET crdt_state = ?, content_hash = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
            params![&merged_state, &content_hash, now, &doc_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let title: String = {
        let db = state.db.lock();
        db.query_row(
            "SELECT title FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };

    indexer::update_document_index(&state.db.lock(), &doc_id, &title)?;

    let _ = db_snapshot.check_and_consolidate(&doc_id, &merged_state);

    eprintln!(
        "[cmd] save_yjs_update doc_id={} emitting sync-received (local echo)",
        doc_id
    );
    let _ = state
        .app_handle
        .emit("sync-received", serde_json::json!({ "doc_id": doc_id }));

    Ok(())
}

// Sets only the content hash for a document, without touching crdt_state or the
// update log. Used by the one-time hash backfill after upgrading.
#[tauri::command]
pub fn set_content_hash(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    content_hash: Vec<u8>,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE documents SET content_hash = ? WHERE id = ?",
        params![&content_hash, &doc_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
