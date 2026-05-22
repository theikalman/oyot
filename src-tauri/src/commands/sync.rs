use crate::crdt::CrdtDocument;
use crate::db::AppState;
use crate::indexer;
use crate::network::peer_manager;
use crate::sync_manager::SyncPeer;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct CrdtStateResult {
    pub doc_id: String,
    pub crdt_state: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PeerList {
    pub peers: Vec<SyncPeer>,
}

#[tauri::command]
pub fn get_crdt_state(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<CrdtStateResult, String> {
    let db = state.db.lock();
    let crdt_state: Vec<u8> = db
        .query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    Ok(CrdtStateResult { doc_id, crdt_state })
}

#[tauri::command]
pub fn save_crdt_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let current_state: Vec<u8> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default()
    };

    let mut doc = CrdtDocument::new();
    if !current_state.is_empty() {
        doc.load_from_state(&current_state)?;
    }
    doc.apply_update(&update)?;
    let new_state = doc.export_state();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET crdt_state = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
            params![&new_state, now, &doc_id],
        )
        .map_err(|e| e.to_string())?;
    }

    indexer::update_document_index(&state.db.lock(), &doc_id, &new_state)?;

    Ok(new_state)
}

#[tauri::command]
pub fn export_document_update_since(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    since_version: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let db = state.db.lock();
    let current_state: Vec<u8> = db
        .query_row(
            "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
            params![&doc_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    drop(db);

    if current_state.is_empty() {
        return Ok(Vec::new());
    }

    let mut doc = CrdtDocument::new();
    doc.load_from_state(&current_state)?;
    doc.export_update_since(&since_version)
}

#[tauri::command]
pub fn get_node_id(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let sync_manager = state.sync_manager.blocking_lock();
    Ok(sync_manager.get_node_id())
}

#[tauri::command]
pub async fn add_sync_peer(
    state: tauri::State<'_, AppState>,
    node_id: String,
    device_name: String,
) -> Result<(), String> {
    {
        let db = state.db.lock();
        peer_manager::save_peer(&db, &node_id, &device_name)?;
    }

    let sync_manager = state.sync_manager.lock().await;
    sync_manager.add_peer(node_id, device_name).await
}

#[tauri::command]
pub async fn get_sync_peers(state: tauri::State<'_, AppState>) -> Result<Vec<SyncPeer>, String> {
    let db_peers = {
        let db = state.db.lock();
        peer_manager::load_trusted_peers(&db)?
    };

    let sync_manager = state.sync_manager.lock().await;
    for peer in &db_peers {
        sync_manager.add_peer(peer.node_id.clone(), peer.device_name.clone()).await;
    }
    Ok(sync_manager.get_peers().await)
}

#[tauri::command]
pub async fn remove_sync_peer(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<(), String> {
    {
        let db = state.db.lock();
        peer_manager::remove_peer(&db, &node_id)?;
    }

    let sync_manager = state.sync_manager.lock().await;
    sync_manager.remove_peer(&node_id).await
}

#[tauri::command]
pub fn set_sync_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut sync_manager = state.sync_manager.blocking_lock();
    sync_manager.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub async fn trigger_sync(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sync_manager = state.sync_manager.lock().await;
    sync_manager.trigger_sync().await
}