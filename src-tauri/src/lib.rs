mod commands;
mod db;
mod db_snapshot;
mod identity;
mod indexer;
mod network;
mod pairing;

use crate::commands::*;
use crate::db::AppState;
use crate::network::peer_connection::PeerEvent;
use crate::network::webrtc_manager::RtcEvent;
use rusqlite::Connection;
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub fn setup_database_tables(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('journal', 'note')),
            title TEXT NOT NULL,
            crdt_state BLOB,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS yjs_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id TEXT NOT NULL,
            update_blob BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS yjs_snapshots (
            document_id TEXT PRIMARY KEY NOT NULL,
            snapshot_blob BLOB NOT NULL,
            last_update_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS document_index (
            document_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            todo_count INTEGER DEFAULT 0,
            completed_todo_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            local_path TEXT,
            is_fully_downloaded INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_peers (
            node_id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            last_synchronized INTEGER
        );

        CREATE TABLE IF NOT EXISTS identity (
            user_id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL DEFAULT 'My Device'
        );

        CREATE TABLE IF NOT EXISTS device_pairs (
            user_id TEXT NOT NULL,
            peer_node_id TEXT NOT NULL,
            peer_display_name TEXT NOT NULL,
            room_id TEXT NOT NULL,
            last_synchronized INTEGER,
            PRIMARY KEY (user_id, peer_node_id)
        );

        CREATE INDEX IF NOT EXISTS idx_yjs_updates_doc ON yjs_updates(document_id);
        CREATE INDEX IF NOT EXISTS idx_device_pairs_room ON device_pairs(room_id);
        CREATE INDEX IF NOT EXISTS idx_device_pairs_user ON device_pairs(user_id);
        ",
    )
    .map_err(|e| format!("Failed to create tables: {}", e))?;
    Ok(())
}

fn read_config(app: &tauri::AppHandle) -> serde_json::Value {
    let config_path = match app.path().app_data_dir() {
        Ok(dir) => dir.join("config.json"),
        Err(_) => return serde_json::Value::Object(Default::default()),
    };
    let content = match std::fs::read_to_string(config_path).ok() {
        Some(c) => c,
        None => return serde_json::Value::Object(Default::default()),
    };
    serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
}

fn spawn_sync_tasks(
    app: tauri::AppHandle,
    webrtc_manager: Arc<crate::network::webrtc_manager::WebRtcManager>,
    peer_registry: Arc<crate::network::peer_connection::PeerRegistry>,
) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");
        rt.block_on(async {
            let app_clone = app.clone();
            let mut rtc_events = webrtc_manager.subscribe();
            tokio::spawn(async move {
                while let Ok(event) = rtc_events.recv().await {
                    match event {
                        RtcEvent::PeerConnected(peer_id) => {
                            let _ = app_clone.emit("peer-connected", peer_id);
                        }
                        RtcEvent::PeerDisconnected(peer_id) => {
                            let _ = app_clone.emit("peer-disconnected", peer_id);
                        }
                        RtcEvent::DataReceived { from, doc_id } => {
                            let _ = app_clone.emit("sync-received", serde_json::json!({ "doc_id": doc_id, "from": from }));
                        }
                        RtcEvent::Error { peer_id, error } => {
                            eprintln!("WebRTC error for peer {}: {}", peer_id, error);
                        }
                    }
                }
            });

            let app_clone2 = app.clone();
            let mut peer_events = peer_registry.subscribe();
            tokio::spawn(async move {
                while let Ok(event) = peer_events.recv().await {
                    match event {
                        PeerEvent::Connected(peer_id) => {
                            let _ = app_clone2.emit("peer-connected", peer_id);
                        }
                        PeerEvent::Disconnected(peer_id) => {
                            let _ = app_clone2.emit("peer-disconnected", peer_id);
                        }
                        PeerEvent::Message { from, doc_id: _ } => {
                            let _ = app_clone2.emit("sync-received", serde_json::json!({ "from": from }));
                        }
                    }
                }
            });

            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let config = read_config(app.handle());
            let signaling_url = config
                .get("signaling_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let state = AppState::new(app.handle().clone(), signaling_url)?;

            {
                let db = state.db.lock();
                setup_database_tables(&db)?;
            }

            {
                let db = state.db.lock();
                let identity = crate::identity::get_or_create_identity(&db)
                    .map_err(|e| format!("Failed to create identity: {}", e))?;
                state.signaling_manager.set_node_id(identity.node_id.clone());
                state.signaling_manager.set_user_id(identity.user_id);
                state.signaling_manager.set_display_name(identity.display_name);
            }

            spawn_sync_tasks(
                app.handle().clone(),
                state.webrtc_manager.clone(),
                state.peer_registry.clone(),
            );

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_all_documents,
            get_document,
            create_document,
            update_document,
            delete_document,
            search_documents,
            get_backlinks,
            get_journals,
            get_or_create_today_journal,
            get_theme,
            save_theme,
            get_signaling_url,
            save_signaling_url,
            get_mqtt_broker_url,
            save_mqtt_broker_url,
            save_image,
            delete_image,
            cleanup_orphaned_images,
            get_attachment_path,
            request_attachment,
            get_attachment_info,
            list_pending_attachments,
            get_local_blob_url,
            get_all_attachment_hashes,
            get_yjs_state,
            save_yjs_update,
            load_document,
            get_identity,
            set_display_name,
            get_node_id,
            get_user_id,
            list_paired_devices,
            remove_pair,
            save_pair,
            derive_room_id,
            update_pair_sync_time,
            trigger_sync,
            create_snapshot,
            get_all_updates,
            get_signaling_status,
            get_sync_peers,
            add_sync_peer,
            remove_sync_peer,
            set_sync_enabled,
            mqtt_connect,
            mqtt_disconnect,
            mqtt_publish_offer,
            mqtt_publish_answer,
            mqtt_publish_ice_candidate,
            get_mqtt_status,
            get_online_peers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}