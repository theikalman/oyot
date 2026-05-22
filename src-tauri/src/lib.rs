mod commands;
mod crdt;
mod db;
mod indexer;
mod network;
mod sync_manager;

use commands::*;
use db::AppState;
use futures_lite::StreamExt;
use iroh::{Endpoint, EndpointId};
use iroh_gossip::net::Gossip;
use iroh_gossip::api::Event;
use network::gossip_broadcaster::{bytes_to_topic_id, GossipBroadcaster};
use network::sync_protocol::SyncMessage;
use std::sync::Arc;
use tauri::{Emitter, Manager};

fn setup_database_tables(db: &rusqlite::Connection) -> Result<(), String> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('journal', 'note')),
            title TEXT NOT NULL,
            crdt_state BLOB NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
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
        ",
    )
    .map_err(|e| format!("Failed to create tables: {}", e))?;
    Ok(())
}

fn get_workspace_path(app: &tauri::AppHandle) -> String {
    let config_dir = app.path().app_config_dir().expect("Failed to get config dir");
    let workspace_path = config_dir.join("workspace");

    if !workspace_path.exists() {
        std::fs::create_dir_all(&workspace_path).expect("Failed to create workspace dir");
    }

    workspace_path.to_string_lossy().to_string()
}

fn init_iroh_endpoint() -> Result<Endpoint, String> {
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        Endpoint::builder(iroh::endpoint::presets::N0)
            .bind()
            .await
            .map_err(|e| format!("Failed to bind Iroh endpoint: {}", e))
    })
}

fn spawn_sync_tasks(
    endpoint: Option<Arc<Endpoint>>,
    gossip: Option<Arc<GossipBroadcaster>>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    app: tauri::AppHandle,
) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");

        rt.block_on(async {
            if let Some(endpoint) = endpoint {
                let db_clone = db.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    accept_incoming_connections(&endpoint, &db_clone, &app_clone).await;
                });
            }

            if let Some(gossip) = gossip {
                let db_clone = db.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    handle_gossip_messages(gossip, db_clone, app_clone).await;
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
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) {
    loop {
        if let Some(incoming) = endpoint.accept().await {
            let db = db.clone();
            let app = app.clone();

            tokio::spawn(async move {
                if let Err(e) = handle_connection(incoming, db, app).await {
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut accepting = incoming.accept().map_err(|e| format!("Accept error: {}", e))?;

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
    let crdt_state: Vec<u8> = {
        let db_lock = db.lock();
        db_lock
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
                [doc_id],
                |row| row.get(0),
            )
            .unwrap_or_default()
    };

    let response = SyncMessage::SendDocDelta {
        doc_id: doc_id.to_string(),
        delta: crdt_state,
    };

    let encoded = response.encode();
    send.write_all(&encoded)
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    let _ = send.finish();

    let _ = app.emit("sync-complete", doc_id);

    Ok(())
}

async fn handle_gossip_messages(
    gossip: Arc<GossipBroadcaster>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    app: tauri::AppHandle,
) {
    let gossip_net = gossip.gossip().clone();
    let topic_id = gossip.topic_id();
    let db_clone = db.clone();
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
                let app = app_clone.clone();
                let from = msg.delivered_from;
                if let Err(e) = process_gossip_message(&db, &app, from, msg.content.as_ref()).await {
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
    app: &tauri::AppHandle,
    from: EndpointId,
    data: &[u8],
) -> Result<(), String> {
    if let Ok(msg) = SyncMessage::decode(data) {
        match msg {
            SyncMessage::SendDocDelta { doc_id, delta } => {
                let _ = apply_crdt_delta(db, &doc_id, &delta).await;
                let _ = app.emit("sync-received", serde_json::json!({ "doc_id": doc_id, "from": from.to_string() }));
            }
            _ => {}
        }
    }
    Ok(())
}

async fn apply_crdt_delta(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    doc_id: &str,
    delta: &[u8],
) -> Result<(), String> {
    let current_state: Vec<u8> = {
        let db_lock = db.lock();
        db_lock
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = ? AND is_deleted = 0",
                [doc_id],
                |row| row.get(0),
            )
            .unwrap_or_default()
    };

    let mut doc = crate::crdt::CrdtDocument::new();
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
                "UPDATE documents SET crdt_state = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
                rusqlite::params![&new_state, now, doc_id],
            )
            .map_err(|e| e.to_string())?;
    }

    crate::indexer::update_document_index(&db.lock(), doc_id, &new_state)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let workspace_path = get_workspace_path(app.handle());
            let mut state = AppState::new(workspace_path)?;

            {
                let db = state.db.lock();
                setup_database_tables(&db)?;
            }

            match init_iroh_endpoint() {
                Ok(endpoint) => {
                    let node_id = endpoint.id().to_string();
                    let mut sync_manager = state.sync_manager.blocking_lock();
                    sync_manager.set_node_id(node_id.clone());
                    drop(sync_manager);

                    state.iroh_endpoint = Some(Arc::new(endpoint.clone()));

                    let gossip = Gossip::builder().spawn(endpoint);
                    let topic_bytes = bytes_to_topic_id("oyot-default-sync-v1");
                    let broadcaster = GossipBroadcaster::new(gossip, topic_bytes);
                    state.gossip_broadcaster = Some(Arc::new(broadcaster));

                    spawn_sync_tasks(
                        state.iroh_endpoint.clone(),
                        state.gossip_broadcaster.clone(),
                        state.db.clone(),
                        app.handle().clone(),
                    );
                }
                Err(e) => {
                    eprintln!("Warning: Failed to initialize Iroh endpoint: {}", e);
                    spawn_sync_tasks(
                        None,
                        None,
                        state.db.clone(),
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
            get_recent_workspaces,
            save_recent_workspace,
            get_theme,
            save_theme,
            get_app_data_dir,
            get_workspace_dir,
            save_image,
            delete_image,
            cleanup_orphaned_images,
            get_attachment_path,
            request_attachment,
            set_current_workspace,
            init_database,
            get_crdt_state,
            save_crdt_update,
            export_document_update_since,
            get_node_id,
            add_sync_peer,
            get_sync_peers,
            remove_sync_peer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}