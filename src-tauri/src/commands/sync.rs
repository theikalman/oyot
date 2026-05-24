use crate::db::AppState;
use crate::network::peer_manager;
use crate::network::sync_protocol::SyncMessage;
use crate::sync_manager::SyncPeer;
use iroh::Endpoint;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;

// ── New Yjs-based document ledger commands ────────────────────────────────────

/// Load all raw Yjs update blobs for a document in insertion order.
/// The frontend applies them sequentially to hydrate the in-memory Y.Doc.
#[tauri::command]
pub fn load_document_ledger(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<Vec<Vec<u8>>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT update_blob FROM document_updates WHERE doc_id = ? ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let updates: Vec<Vec<u8>> = stmt
        .query_map(params![&doc_id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(updates)
}

/// Persist one Yjs binary update chunk and update the document title.
/// Called for every local edit event.
#[tauri::command]
pub fn commit_local_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update_blob: Vec<u8>,
    title: String,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let db = state.db.lock();

    db.execute(
        "INSERT INTO document_updates (doc_id, update_blob, timestamp, origin_peer_id) VALUES (?, ?, ?, NULL)",
        params![&doc_id, &update_blob, now],
    )
    .map_err(|e| e.to_string())?;

    db.execute(
        "UPDATE documents SET title = ?, updated_at = ? WHERE id = ?",
        params![&title, now, &doc_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Broadcast a raw Yjs update blob to all gossip peers.
/// Does NOT write to the local DB — commit_local_update handles persistence.
#[tauri::command]
pub fn broadcast_p2p_update(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    update_blob: Vec<u8>,
) -> Result<(), String> {
    if let Some(broadcaster) = &state.gossip_broadcaster {
        let broadcaster = broadcaster.clone();
        let doc_id_clone = doc_id.clone();
        let update_clone = update_blob.clone();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("Failed to create runtime: {}", e);
                    return;
                }
            };
            rt.block_on(async move {
                let msg = SyncMessage::SendDocDelta {
                    doc_id: doc_id_clone,
                    delta: update_clone,
                };
                let _ = broadcaster.broadcast(msg.encode()).await;
            });
        });
    }
    Ok(())
}

// ── Peer / sync management (unchanged) ───────────────────────────────────────

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
        let _ = sync_manager
            .add_peer(peer.node_id.clone(), peer.device_name.clone())
            .await;
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

/// Trigger a full catch-up QUIC sync with all known peers.
/// Requests all updates for every local document and stores received blobs.
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
            if let Err(e) =
                sync_with_peer(&endpoint_clone, &node_id, &db_clone, &app_clone).await
            {
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

    let peer_key = PublicKey::from_z32(node_id)
        .map_err(|e| format!("Invalid peer node ID: {}", e))?;

    let conn = endpoint
        .connect(peer_key, b"oyot-sync-v1")
        .await
        .map_err(|e| format!("Failed to connect to peer: {}", e))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("Failed to open bi-stream: {}", e))?;

    // Collect all local doc IDs
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

    // Request all docs from peer (no state_vector needed — Yjs handles merging on JS side)
    for doc_id in &doc_ids {
        let msg = SyncMessage::RequestDoc {
            doc_id: doc_id.clone(),
            state_vector: vec![],
        };
        send.write_all(&msg.encode())
            .await
            .map_err(|e| format!("Write error: {}", e))?;
    }

    send.finish().map_err(|e| e.to_string())?;

    loop {
        match recv.read_to_end(4 * 1024 * 1024).await {
            Ok(data) if data.is_empty() => break,
            Ok(data) => {
                if let Ok(msg) = SyncMessage::decode(&data) {
                    match msg {
                        SyncMessage::SendDocUpdates { doc_id, updates } => {
                            for update in &updates {
                                let _ = crate::store_remote_update(db, &doc_id, update, Some(node_id));
                                let _ = app.emit(
                                    "remote_network_update",
                                    serde_json::json!({
                                        "doc_id": doc_id,
                                        "update_blob": update,
                                        "origin": node_id
                                    }),
                                );
                            }
                        }
                        // Legacy single-delta response (forward compat)
                        SyncMessage::SendDocDelta { doc_id, delta } => {
                            let _ = crate::store_remote_update(db, &doc_id, &delta, Some(node_id));
                            let _ = app.emit(
                                "remote_network_update",
                                serde_json::json!({ "doc_id": doc_id }),
                            );
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

// ── Internal helpers re-exported for use in lib.rs ───────────────────────────
#[derive(Debug, Serialize, Deserialize)]
pub struct NodeIdResult {
    pub node_id: Option<String>,
}
