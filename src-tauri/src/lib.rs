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
            content_hash BLOB,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            title_updated_at INTEGER,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            lifecycle_updated_at INTEGER
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

/// The schema version `run_migrations` brings a database up to. Bump it in the
/// same change that adds the migration block.
pub const SCHEMA_VERSION: i64 = 2;

/// Additive schema migrations, keyed off `PRAGMA user_version`. Each block runs
/// once and bumps the version. `setup_database_tables` still owns the base
/// `CREATE TABLE IF NOT EXISTS` shape for fresh installs; this only carries
/// existing databases forward.
pub fn run_migrations(db: &Connection) -> Result<(), String> {
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);

    // v1: columns that let the sync layer reconcile the whole document set
    // (content hash as a change detector, last-writer-wins title, delete
    // tombstone timestamp). See docs/decisions/0003-full-document-set-sync.md.
    if version < 1 {
        // `ALTER TABLE ... ADD COLUMN` is not idempotent, so guard on a fresh
        // install where the column may already exist from a newer base schema.
        let has_content_hash = db
            .prepare("SELECT content_hash FROM documents LIMIT 0")
            .is_ok();
        if !has_content_hash {
            db.execute_batch(
                "
                ALTER TABLE documents ADD COLUMN content_hash BLOB;
                ALTER TABLE documents ADD COLUMN title_updated_at INTEGER;
                ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
                UPDATE documents SET title_updated_at = updated_at WHERE title_updated_at IS NULL;
                ",
            )
            .map_err(|e| format!("Migration v1 failed: {}", e))?;
        }
        db.execute_batch("PRAGMA user_version = 1;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v2: `lifecycle_updated_at` turns the delete flag into a last-writer-wins
    // register, the same shape `title_updated_at` gives the title. Without it a
    // revived document loses to any peer still holding the tombstone, because
    // reconciliation branched on `is_deleted` alone with no way to tell which
    // side observed it later.
    if version < 2 {
        let has_lifecycle = db
            .prepare("SELECT lifecycle_updated_at FROM documents LIMIT 0")
            .is_ok();
        if !has_lifecycle {
            db.execute_batch("ALTER TABLE documents ADD COLUMN lifecycle_updated_at INTEGER;")
                .map_err(|e| format!("Migration v2 failed: {}", e))?;
        }
        // Seed from the best stamp already on the row: a tombstone's own
        // timestamp if it has one, otherwise whenever the row last changed.
        db.execute_batch(
            "UPDATE documents
                SET lifecycle_updated_at =
                    COALESCE(deleted_at, title_updated_at, updated_at, created_at)
              WHERE lifecycle_updated_at IS NULL;",
        )
        .map_err(|e| format!("Migration v2 backfill failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 2;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

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
                eprintln!("[lib] Rust-side webrtc_manager event forwarder started");
                while let Ok(event) = rtc_events.recv().await {
                    match event {
                        RtcEvent::PeerConnected(peer_id) => {
                            eprintln!("[lib] webrtc_manager RtcEvent::PeerConnected {} -> emitting peer-connected", peer_id);
                            let _ = app_clone.emit("peer-connected", peer_id);
                        }
                        RtcEvent::PeerDisconnected(peer_id) => {
                            eprintln!("[lib] webrtc_manager RtcEvent::PeerDisconnected {} -> emitting peer-disconnected", peer_id);
                            let _ = app_clone.emit("peer-disconnected", peer_id);
                        }
                        RtcEvent::DataReceived { from, doc_id } => {
                            eprintln!("[lib] webrtc_manager RtcEvent::DataReceived from={} doc_id={} -> emitting sync-received", from, doc_id);
                            let _ = app_clone.emit("sync-received", serde_json::json!({ "doc_id": doc_id, "from": from }));
                        }
                        RtcEvent::Error { peer_id, error } => {
                            eprintln!("[lib] WebRTC error for peer {}: {}", peer_id, error);
                        }
                    }
                }
                eprintln!("[lib] Rust-side webrtc_manager event forwarder exited");
            });

            let app_clone2 = app.clone();
            let mut peer_events = peer_registry.subscribe();
            tokio::spawn(async move {
                eprintln!("[lib] Rust-side peer_registry event forwarder started");
                while let Ok(event) = peer_events.recv().await {
                    match event {
                        PeerEvent::Connected(peer_id) => {
                            eprintln!("[lib] peer_registry PeerEvent::Connected {} -> emitting peer-connected", peer_id);
                            let _ = app_clone2.emit("peer-connected", peer_id);
                        }
                        PeerEvent::Disconnected(peer_id) => {
                            eprintln!("[lib] peer_registry PeerEvent::Disconnected {} -> emitting peer-disconnected", peer_id);
                            let _ = app_clone2.emit("peer-disconnected", peer_id);
                        }
                        PeerEvent::Message { from, doc_id: _ } => {
                            eprintln!("[lib] peer_registry PeerEvent::Message from={} -> emitting sync-received", from);
                            let _ = app_clone2.emit("sync-received", serde_json::json!({ "from": from }));
                        }
                    }
                }
                eprintln!("[lib] Rust-side peer_registry event forwarder exited");
            });

            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            }
        });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
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
                run_migrations(&db)?;
            }

            {
                let db = state.db.lock();
                let identity = crate::identity::get_or_create_identity(&db)
                    .map_err(|e| format!("Failed to create identity: {}", e))?;
                state
                    .signaling_manager
                    .set_node_id(identity.node_id.clone());
                state.signaling_manager.set_user_id(identity.user_id);
                state
                    .signaling_manager
                    .set_display_name(identity.display_name);
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
            get_all_documents_full,
            get_document,
            create_document,
            update_document,
            delete_document,
            list_document_sync_state,
            ensure_document,
            apply_remote_rename,
            apply_remote_delete,
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
            list_attachment_manifest,
            get_attachment_bytes,
            save_attachment_bytes,
            get_yjs_state,
            save_yjs_update,
            set_content_hash,
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
            mqtt_publish_pair_request,
            mqtt_accept_pair_request,
            mqtt_decline_pair_request,
            mqtt_publish_offer,
            mqtt_publish_answer,
            mqtt_publish_ice_candidate,
            get_mqtt_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    // Simulates a database created before ADR 0003 (no content_hash column).
    fn legacy_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE documents (
                id TEXT PRIMARY KEY NOT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                crdt_state BLOB,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                is_deleted INTEGER DEFAULT 0
            );
            INSERT INTO documents (id, type, title, created_at, updated_at)
                VALUES ('d1', 'note', 'One', 100, 200);",
        )
        .unwrap();
        db
    }

    fn column_exists(db: &Connection, col: &str) -> bool {
        db.prepare(&format!("SELECT {col} FROM documents LIMIT 0"))
            .is_ok()
    }

    #[test]
    fn migrates_a_legacy_database_and_backfills_title_timestamp() {
        let db = legacy_db();
        run_migrations(&db).unwrap();

        assert!(column_exists(&db, "content_hash"));
        assert!(column_exists(&db, "title_updated_at"));
        assert!(column_exists(&db, "deleted_at"));

        let title_ts: i64 = db
            .query_row(
                "SELECT title_updated_at FROM documents WHERE id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title_ts, 200, "title_updated_at backfills from updated_at");

        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn is_idempotent() {
        let db = legacy_db();
        run_migrations(&db).unwrap();
        run_migrations(&db).unwrap();
        run_migrations(&db).unwrap();
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn is_a_noop_on_a_fresh_schema() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        run_migrations(&db).unwrap();
        assert!(column_exists(&db, "content_hash"));
    }

    #[test]
    fn migrates_v1_to_v2_and_seeds_the_lifecycle_stamp() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        // Simulate a v1 database: schema has the column, but no row was ever
        // stamped because the code that writes it did not exist yet.
        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at, title_updated_at, is_deleted, deleted_at)
                 VALUES ('live', 'note', 'Live', 10, 20, 30, 0, NULL);
             INSERT INTO documents (id, type, title, created_at, updated_at, title_updated_at, is_deleted, deleted_at)
                 VALUES ('dead', 'note', 'Dead', 10, 20, 30, 1, 99);
             UPDATE documents SET lifecycle_updated_at = NULL;
             PRAGMA user_version = 1;",
        )
        .unwrap();

        run_migrations(&db).unwrap();

        let stamp = |id: &str| -> i64 {
            db.query_row(
                "SELECT lifecycle_updated_at FROM documents WHERE id = ?",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(stamp("dead"), 99, "a tombstone seeds from its deleted_at");
        assert_eq!(stamp("live"), 30, "a live row seeds from title_updated_at");

        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    // Mirrors the get_or_create_today_journal upsert. A journal id is derived
    // from its date, so a deleted journal's tombstone still owns the id and the
    // old plain INSERT failed the primary key, taking app startup with it.
    #[test]
    fn creating_a_journal_revives_its_tombstone() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();

        let upsert = "INSERT INTO documents
                          (id, type, title, created_at, updated_at, title_updated_at,
                           is_deleted, deleted_at, lifecycle_updated_at)
                      VALUES (?1, 'journal', ?2, ?3, ?3, ?3, 0, NULL, ?3)
                      ON CONFLICT(id) DO UPDATE SET
                          is_deleted           = 0,
                          deleted_at           = NULL,
                          lifecycle_updated_at = CASE
                              WHEN documents.is_deleted = 1 THEN excluded.lifecycle_updated_at
                              ELSE documents.lifecycle_updated_at
                          END";

        db.execute(
            upsert,
            rusqlite::params!["14 Sep 2026", "2026-09-14", 100_i64],
        )
        .unwrap();
        db.execute(
            "UPDATE documents SET is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1 WHERE id = ?2",
            rusqlite::params![200_i64, "14 Sep 2026"],
        )
        .unwrap();

        // The call that used to fail with UNIQUE constraint failed.
        db.execute(
            upsert,
            rusqlite::params!["14 Sep 2026", "2026-09-14", 300_i64],
        )
        .unwrap();

        let (deleted, stamp): (i64, i64) = db
            .query_row(
                "SELECT is_deleted, lifecycle_updated_at FROM documents WHERE id = '14 Sep 2026'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted, 0, "the tombstone is cleared");
        assert_eq!(stamp, 300, "the revival is stamped later than the delete");

        let rows: i64 = db
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "revival reuses the row, it does not duplicate it");
    }

    // Mirrors apply_remote_delete: a peer's tombstone only applies when it is
    // the later observation, otherwise it would undo a revival that came after.
    #[test]
    fn a_remote_tombstone_loses_to_a_later_revival() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at, title_updated_at, is_deleted, lifecycle_updated_at)
                 VALUES ('d1', 'note', 'One', 1, 1, 1, 0, 500)",
            [],
        )
        .unwrap();

        let sql = "UPDATE documents
                      SET is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1
                    WHERE id = ?2
                      AND (lifecycle_updated_at IS NULL OR lifecycle_updated_at < ?1)";

        let stale = db.execute(sql, rusqlite::params![400_i64, "d1"]).unwrap();
        assert_eq!(
            stale, 0,
            "a tombstone older than our revival does not apply"
        );

        let fresh = db.execute(sql, rusqlite::params![600_i64, "d1"]).unwrap();
        assert_eq!(fresh, 1, "a newer tombstone applies");
    }

    // Mirrors the apply_remote_rename SQL so the last-writer-wins tiebreak is
    // covered without a Tauri State harness.
    #[test]
    fn remote_rename_is_last_writer_wins() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at, title_updated_at)
             VALUES ('d1', 'note', 'Original', 1, 1, 10)",
            [],
        )
        .unwrap();

        let sql = "UPDATE documents SET title = ?1, title_updated_at = ?2 \
                   WHERE id = ?3 AND (title_updated_at IS NULL OR title_updated_at < ?2)";

        let stale = db
            .execute(sql, rusqlite::params!["Stale", 5_i64, "d1"])
            .unwrap();
        assert_eq!(stale, 0, "an older stamp does not apply");

        let fresh = db
            .execute(sql, rusqlite::params!["Fresh", 20_i64, "d1"])
            .unwrap();
        assert_eq!(fresh, 1, "a newer stamp applies");

        let title: String = db
            .query_row("SELECT title FROM documents WHERE id = 'd1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Fresh");
    }
}
