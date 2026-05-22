use crate::crdt::CrdtDocument;
use crate::db::AppState;
use crate::indexer;
use crate::network::peer_manager;
use crate::network::sync_protocol::SyncMessage;
use crate::sync_manager::SyncPeer;
use iroh::Endpoint;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
pub struct CrdtStateResult {
    pub doc_id: String,
    pub crdt_state: Vec<u8>,
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

    if let Some(broadcaster) = &state.gossip_broadcaster {
        let broadcaster = broadcaster.clone();
        let doc_id_clone = doc_id.clone();
        let update_clone = update.clone();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => { eprintln!("Failed to create runtime: {}", e); return; }
            };
            rt.block_on(async move {
                let msg = crate::network::sync_protocol::SyncMessage::SendDocDelta {
                    doc_id: doc_id_clone,
                    delta: update_clone,
                };
                let _ = broadcaster.broadcast(msg.encode()).await;
            });
        });
    }

    Ok(new_state)
}

#[tauri::command]
pub fn export_document_update_since(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    since_version: Vec<u8>,
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

    if current_state.is_empty() {
        return Ok(Vec::new());
    }

    let mut doc = crate::crdt::CrdtDocument::new();
    doc.load_from_state(&current_state)?;

    let sv: loro::VersionVector = serde_json::from_slice(&since_version)
        .map_err(|e| format!("Invalid state vector: {}", e))?;

    doc.export_update_since(&sv)
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
        let _ = sync_manager.add_peer(peer.node_id.clone(), peer.device_name.clone()).await;
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
    if !sync_manager.is_enabled() {
        return Err("Sync is disabled".to_string());
    }

    let peers = sync_manager.get_peers().await;
    drop(sync_manager);

    if peers.is_empty() {
        return Ok(());
    }

    let endpoint = match &state.iroh_endpoint {
        Some(ep) => ep.clone(),
        None => return Err("Iroh endpoint not initialized".to_string()),
    };

    let db = state.db.clone();
    let app = state.app_handle.clone();

    for peer in peers {
        let node_id = peer.node_id.clone();
        let app_clone = app.clone();
        let db_clone = db.clone();
        let endpoint_clone = endpoint.clone();

        tokio::spawn(async move {
            if let Err(e) = sync_with_peer(&endpoint_clone, &node_id, &db_clone, &app_clone).await {
                eprintln!("Failed to sync with peer {}: {}", node_id, e);
            }
        });
    }

    Ok(())
}

async fn sync_with_peer(
    endpoint: &Arc<Endpoint>,
    node_id: &str,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use iroh::PublicKey;

    let peer_key = PublicKey::from_z32(&node_id)
        .map_err(|e| format!("Invalid peer node ID: {}", e))?;

    let conn = endpoint
        .connect(peer_key, b"oyot-sync-v1")
        .await
        .map_err(|e| format!("Failed to connect to peer: {}", e))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("Failed to open bi-stream: {}", e))?;

    let doc_ids: Vec<String> = {
        let db_lock = db.lock();
        let result: Result<Vec<String>, _> = db_lock
            .prepare("SELECT id FROM documents WHERE is_deleted = 0")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
            });
        result.map_err(|e| e.to_string())?
    };

    for doc_id in &doc_ids {
        let state_vector: Vec<u8> = {
            let db_lock = db.lock();
            db_lock
                .query_row(
                    "SELECT crdt_state FROM documents WHERE id = ?",
                    params![doc_id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .unwrap_or_default()
        };

        let msg = SyncMessage::RequestDoc {
            doc_id: doc_id.clone(),
            state_vector,
        };
        send.write_all(&msg.encode())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
    }

    send.finish().map_err(|e| e.to_string())?;

    loop {
        match recv.read_to_end(1024 * 1024).await {
            Ok(data) if data.is_empty() => break,
            Ok(data) => {
                if let Ok(msg) = SyncMessage::decode(&data) {
                    match msg {
                        SyncMessage::SendDocDelta { doc_id, delta } => {
                            let _ = apply_crdt_delta_sync(db, &doc_id, &delta).await;
                            let _ = app.emit("sync-received", serde_json::json!({ "doc_id": doc_id }));
                        }
                        SyncMessage::SendBlob { hash, data: blob_data, mime_type } => {
                            let workspace_path = "";
                            let _ = save_blob_to_disk_sync(workspace_path, &hash, &mime_type, &blob_data);
                            let _ = update_attachment_db_sync(db, &hash, &mime_type, workspace_path);
                        }
                        SyncMessage::DocSyncComplete { doc_id } => {
                            let _ = app.emit("sync-complete", doc_id);
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                eprintln!("Read error: {}", e);
                break;
            }
        }
    }

    Ok(())
}

async fn apply_crdt_delta_sync(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    doc_id: &str,
    delta: &[u8],
) -> Result<(), String> {
    let current_state: Vec<u8> = {
        let db_lock = db.lock();
        db_lock
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
                params![doc_id],
                |row| row.get(0),
            )
            .unwrap_or_default()
    };

    let mut doc = CrdtDocument::new();
    if !current_state.is_empty() {
        doc.load_from_state(&current_state)?;
    }
    doc.apply_update(delta)?;
    let new_state = doc.export_state();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    {
        let db_lock = db.lock();
        db_lock
            .execute(
                "UPDATE documents SET crdt_state = ?, updated_at = ? WHERE id = ?",
                params![&new_state, now, doc_id],
            )
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn save_blob_to_disk_sync(workspace_path: &str, hash: &str, mime_type: &str, data: &[u8]) -> Result<String, String> {
    let ext = match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    let filename = format!("{}.{}", hash, ext);
    let attachments_dir = std::path::PathBuf::from(workspace_path).join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    let full_path = attachments_dir.join(&filename);
    std::fs::write(&full_path, data).map_err(|e| e.to_string())?;
    Ok(format!("attachments/{}", filename))
}

fn update_attachment_db_sync(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    hash: &str,
    mime_type: &str,
    _workspace_path: &str,
) -> Result<(), String> {
    let ext = match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    let filename = format!("{}.{}", hash, ext);
    let relative_path = format!("attachments/{}", filename);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let db_lock = db.lock();
    db_lock.execute(
        "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
        rusqlite::params![hash, mime_type, &relative_path, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
