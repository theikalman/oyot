use crate::db::AppState;
use crate::indexer;
use crate::network::peer_manager;
use crate::network::webrtc_manager::WebRtcMessage;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct YjsStateResult {
    pub doc_id: String,
    pub state: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentMetadata {
    pub doc_id: String,
    pub title: String,
    pub doc_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn get_yjs_state(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<YjsStateResult, String> {
    let state_vec = {
        let db = state.db.lock();
        db.query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };
    Ok(YjsStateResult { doc_id, state: state_vec })
}

#[tauri::command]
pub async fn save_yjs_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: Vec<u8>,
    merged_state: Vec<u8>,
) -> Result<(), String> {
    let db_snapshot = state.snapshot.clone();
    db_snapshot.append_update(&doc_id, &update)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET crdt_state = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
            params![&merged_state, now, &doc_id],
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

    state.webrtc_manager.broadcast_message(
        WebRtcMessage::CrdtUpdate {
            doc_id: doc_id.clone(),
            update,
        },
        None,
    ).await;

    let _ = state.app_handle.emit("sync-received", serde_json::json!({ "doc_id": doc_id }));

    Ok(())
}

#[tauri::command]
pub fn load_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<DocumentMetadata, String> {
    let db = state.db.lock();
    let meta: DocumentMetadata = db
        .query_row(
            "SELECT id, title, type, created_at, updated_at FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| {
                Ok(DocumentMetadata {
                    doc_id: row.get(0)?,
                    title: row.get(1)?,
                    doc_type: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(meta)
}

#[tauri::command]
pub async fn add_sync_peer(
    state: tauri::State<'_, AppState>,
    peer_id: String,
    display_name: String,
) -> Result<(), String> {
    {
        let db = state.db.lock();
        peer_manager::save_peer(&db, &peer_id, &display_name)?;
    }

    let _ = state.peer_registry.add_peer(peer_id.clone(), display_name).await;
    state.webrtc_manager.register_channel(peer_id.clone()).await;

    Ok(())
}

#[tauri::command]
pub async fn get_sync_peers(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let db_peers = {
        let db = state.db.lock();
        peer_manager::load_trusted_peers(&db)?
    };

    let mut result = Vec::new();
    for peer in db_peers {
        let _ = state.peer_registry.add_peer(peer.node_id.clone(), peer.device_name.clone()).await;
        result.push(serde_json::json!({
            "node_id": peer.node_id,
            "device_name": peer.device_name,
        }));
    }

    Ok(result)
}

#[tauri::command]
pub async fn remove_sync_peer(
    state: tauri::State<'_, AppState>,
    peer_id: String,
) -> Result<(), String> {
    {
        let db = state.db.lock();
        peer_manager::remove_peer(&db, &peer_id)?;
    }

    state.peer_registry.remove_peer(&peer_id).await;
    state.webrtc_manager.unregister_channel(&peer_id).await;
    Ok(())
}

#[tauri::command]
pub fn set_sync_enabled(_state: tauri::State<'_, AppState>, _enabled: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let peers = state.webrtc_manager.get_connected_peers().await;
    for peer_id in peers {
        state.webrtc_manager.send_to_peer(
            &peer_id,
            WebRtcMessage::CrdtStateRequest {
                doc_id: String::new(),
            },
        ).await?;
    }
    Ok(())
}

#[tauri::command]
pub fn create_snapshot(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    snapshot_blob: Vec<u8>,
) -> Result<(), String> {
    let last_update_id = state.snapshot.get_latest_update_id(&doc_id)?;
    state.snapshot.save_snapshot(&doc_id, &snapshot_blob, last_update_id)
}

#[tauri::command]
pub fn get_all_updates(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<Vec<Vec<u8>>, String> {
    state.snapshot.get_all_updates(&doc_id)
}