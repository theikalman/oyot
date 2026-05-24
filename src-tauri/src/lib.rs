mod commands;
mod db;
mod network;
mod sync_manager;

use crate::commands::*;
use db::AppState;
use futures_lite::StreamExt;
use iroh::{Endpoint, EndpointId};
use iroh_gossip::api::Event;
use network::gossip_broadcaster::GossipBroadcaster;
use network::sync_protocol::SyncMessage;
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub fn setup_database_tables(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS documents (
            id          TEXT    PRIMARY KEY,
            type        TEXT    NOT NULL CHECK(type IN ('journal', 'note')),
            title       TEXT    NOT NULL DEFAULT 'Untitled',
            is_deleted  INTEGER DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS document_updates (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id          TEXT    NOT NULL,
            update_blob     BLOB    NOT NULL,
            timestamp       INTEGER NOT NULL,
            origin_peer_id  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_doc_updates_doc_id
            ON document_updates (doc_id, id ASC);

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
        ",
    )
    .map_err(|e| format!("Failed to create tables: {}", e))?;
    Ok(())
}

fn init_iroh_endpoint_and_gossip() -> Result<(iroh::Endpoint, Option<Arc<GossipBroadcaster>>), String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        use iroh_gossip::net::Gossip;
        use network::gossip_broadcaster::{bytes_to_topic_id, GossipBroadcaster};

        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .bind()
            .await
            .map_err(|e| format!("Failed to bind Iroh endpoint: {}", e))?;

        let gossip = Gossip::builder().spawn(endpoint.clone());
        let topic_bytes = bytes_to_topic_id("oyot-default-sync-v1");
        let broadcaster = GossipBroadcaster::new(gossip, topic_bytes);

        Ok((endpoint, Some(Arc::new(broadcaster))))
    })
}

fn spawn_sync_tasks(
    endpoint: Option<Arc<Endpoint>>,
    gossip: Option<Arc<GossipBroadcaster>>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: String,
    app: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");

        rt.block_on(async {
            if let Some(endpoint) = endpoint {
                let db_clone = db.clone();
                let data_clone = data_path.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    accept_incoming_connections(&endpoint, db_clone, data_clone, &app_clone).await;
                });
            }

            if let Some(gossip) = gossip {
                let db_clone = db.clone();
                let data_clone = data_path.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    handle_gossip_messages(gossip, db_clone, data_clone, app_clone).await;
                });
            }

            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            }
        });
    });
}

async fn accept_incoming_connections(
    endpoint: &Arc<Endpoint>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: String,
    app: &tauri::AppHandle,
) {
    loop {
        if let Some(incoming) = endpoint.accept().await {
            let db = db.clone();
            let data_path = data_path.clone();
            let app = app.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(incoming, db, data_path, app).await {
                    eprintln!("Error handling connection: {}", e);
                }
            });
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

async fn handle_connection(
    incoming: iroh::endpoint::Incoming,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let accepting = incoming.accept().map_err(|e| format!("Accept error: {}", e))?;

    let conn = accepting
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    let remote_id = conn.remote_id();
    let (mut send, mut recv) = conn
        .accept_bi()
        .await
        .map_err(|e| format!("Failed to accept bi-stream: {}", e))?;

    let buf = recv
        .read_to_end(1024 * 1024)
        .await
        .map_err(|e| format!("Read error: {}", e))?;

    if buf.is_empty() {
        return Ok(());
    }

    let msg = SyncMessage::decode(&buf).map_err(|e| format!("Decode error: {}", e))?;

    match msg {
        SyncMessage::RequestDoc { doc_id, state_vector: _ } => {
            handle_doc_request(&mut send, &db, &doc_id, &app).await?;
        }
        SyncMessage::RequestBlob { hash } => {
            handle_blob_request(&mut send, &db, &data_path, &hash).await?;
        }
        _ => {
            eprintln!("Unexpected message type received");
        }
    }

    let _ = app.emit("peer-connected", remote_id.to_string());

    Ok(())
}

async fn handle_doc_request(
    send: &mut iroh::endpoint::SendStream,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    doc_id: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let updates: Vec<Vec<u8>> = {
        let db_lock = db.lock();
        let mut stmt = db_lock
            .prepare("SELECT update_blob FROM document_updates WHERE doc_id = ? ORDER BY id ASC")
            .map_err(|e| e.to_string())?;
        let result: Vec<Vec<u8>> = stmt.query_map([doc_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        result
    };

    let response = SyncMessage::SendDocUpdates {
        doc_id: doc_id.to_string(),
        updates,
    };

    let encoded = response.encode();
    send.write_all(&encoded)
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    let _ = send.finish();

    let _ = app.emit("sync-complete", doc_id);

    Ok(())
}

async fn handle_blob_request(
    send: &mut iroh::endpoint::SendStream,
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: &str,
    hash: &str,
) -> Result<(), String> {
    let (data, mime_type): (Option<Vec<u8>>, Option<String>) = {
        let db_lock = db.lock();
        let result: Option<(String, String)> = db_lock
            .query_row(
                "SELECT local_path, mime_type FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
                [hash],
                |row| {
                    let local_path: String = row.get(0)?;
                    let mime_type: String = row.get(1)?;
                    Ok((local_path, mime_type))
                },
            )
            .ok();

        if let Some((local_path, mime_type)) = result {
            let full_path = std::path::PathBuf::from(data_path).join(&local_path);
            let data = std::fs::read(&full_path).ok();
            (data, Some(mime_type))
        } else {
            (None, None)
        }
    };

    let response = if let (Some(data), Some(mime)) = (data, mime_type) {
        SyncMessage::SendBlob {
            hash: hash.to_string(),
            data,
            mime_type: mime,
        }
    } else {
        SyncMessage::BlobReceived {
            hash: hash.to_string(),
        }
    };

    let encoded = response.encode();
    send.write_all(&encoded)
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    let _ = send.finish();

    Ok(())
}

async fn handle_gossip_messages(
    gossip: Arc<GossipBroadcaster>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: String,
    app: tauri::AppHandle,
) {
    let gossip_net = gossip.gossip().clone();
    let topic_id = gossip.topic_id();
    let db_clone = db.clone();
    let data_clone = data_path.clone();
    let app_clone = app.clone();

    let topic = match gossip_net.subscribe(topic_id, vec![]).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Failed to subscribe to gossip topic: {}", e);
            return;
        }
    };

    let (_sender, mut receiver) = topic.split();

    while let Some(result) = receiver.next().await {
        match result {
            Ok(Event::Received(msg)) => {
                let db = db_clone.clone();
                let data_path = data_clone.clone();
                let app = app_clone.clone();
                let from = msg.delivered_from;
                if let Err(e) = process_gossip_message(&db, &data_path, &app, from, msg.content.as_ref()).await {
                    eprintln!("Error processing gossip: {}", e);
                }
            }
            Ok(Event::NeighborUp(who)) => {
                let _ = app_clone.emit("peer-connected", who.to_string());
            }
            Ok(Event::NeighborDown(who)) => {
                let _ = app_clone.emit("peer-disconnected", who.to_string());
            }
            Ok(Event::Lagged) => {
                eprintln!("Gossip receiver lagged behind");
            }
            Err(e) => {
                eprintln!("Gossip receive error: {}", e);
            }
        }
    }
}

async fn process_gossip_message(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    data_path: &str,
    app: &tauri::AppHandle,
    from: EndpointId,
    data: &[u8],
) -> Result<(), String> {
    if let Ok(msg) = SyncMessage::decode(data) {
        match msg {
            SyncMessage::SendDocDelta { doc_id, delta } => {
                let origin_peer_id = from.to_string();
                store_remote_update(db, &doc_id, &delta, Some(&origin_peer_id))?;
                let _ = app.emit(
                    "remote_network_update",
                    serde_json::json!({
                        "doc_id": doc_id,
                        "update_blob": delta,
                        "origin": origin_peer_id
                    }),
                );
            }
            SyncMessage::SendBlob { hash, data: blob_data, mime_type } => {
                let _ = save_blob_to_disk(data_path, &hash, &mime_type, &blob_data);
                let _ = update_attachment_db(db, &hash, &mime_type);
                let _ = app.emit("blob-received", serde_json::json!({ "hash": hash }));
            }
            SyncMessage::BlobReceived { hash } => {
                let _ = app.emit("blob-request-ack", serde_json::json!({ "hash": hash }));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Store a raw Yjs update blob into the document_updates log and bump the document's updated_at.
pub fn store_remote_update(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    doc_id: &str,
    update_blob: &[u8],
    origin_peer_id: Option<&str>,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let db_lock = db.lock();
    db_lock
        .execute(
            "INSERT INTO document_updates (doc_id, update_blob, timestamp, origin_peer_id) VALUES (?, ?, ?, ?)",
            rusqlite::params![doc_id, update_blob, now, origin_peer_id],
        )
        .map_err(|e| e.to_string())?;

    db_lock
        .execute(
            "UPDATE documents SET updated_at = ? WHERE id = ?",
            rusqlite::params![now, doc_id],
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn save_blob_to_disk(data_path: &str, hash: &str, mime_type: &str, data: &[u8]) -> Result<String, String> {
    let ext = match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    let filename = format!("{}.{}", hash, ext);

    let attachments_dir = std::path::PathBuf::from(data_path).join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let full_path = attachments_dir.join(&filename);
    std::fs::write(&full_path, data).map_err(|e| e.to_string())?;

    Ok(format!("attachments/{}", filename))
}

fn update_attachment_db(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    hash: &str,
    mime_type: &str,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app.handle().path().app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            let data_path = app_data_dir.to_string_lossy().to_string();

            let mut state = AppState::new(app.handle().clone())?;

            {
                let db = state.db.lock();
                setup_database_tables(&db)?;
            }

            match init_iroh_endpoint_and_gossip() {
                Ok((endpoint, gossip)) => {
                    let node_id = endpoint.id().to_string();
                    let mut sync_manager = state.sync_manager.blocking_lock();
                    sync_manager.set_node_id(node_id.clone());
                    drop(sync_manager);

                    state.iroh_endpoint = Some(Arc::new(endpoint));
                    state.gossip_broadcaster = gossip;

                    spawn_sync_tasks(
                        state.iroh_endpoint.clone(),
                        state.gossip_broadcaster.clone(),
                        state.db.clone(),
                        data_path,
                        app.handle().clone(),
                    );
                }
                Err(e) => {
                    eprintln!("Warning: Failed to initialize Iroh endpoint: {}", e);
                    let data_path = state.data_dir.to_string_lossy().to_string();
                    spawn_sync_tasks(
                        None,
                        None,
                        state.db.clone(),
                        data_path,
                        app.handle().clone(),
                    );
                }
            }

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
            save_image,
            delete_image,
            cleanup_orphaned_images,
            get_attachment_path,
            request_attachment,
            get_attachment_info,
            list_pending_attachments,
            get_local_blob_url,
            get_all_attachment_hashes,
            get_node_id,
            add_sync_peer,
            get_sync_peers,
            remove_sync_peer,
            set_sync_enabled,
            trigger_sync,
            load_document_ledger,
            commit_local_update,
            broadcast_p2p_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
