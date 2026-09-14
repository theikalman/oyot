#[macro_use]
mod logging;

mod commands;
mod crypto;
mod db;
mod db_snapshot;
mod identity;
mod indexer;
mod network;
mod pairing;

use crate::commands::*;
use crate::db::AppState;
use rusqlite::Connection;
use tauri::Manager;

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

        -- Which documents link to which. Content lives in the CRDT, so link
        -- structure is not derivable from SQL; the editor extracts it on save.
        CREATE TABLE IF NOT EXISTS document_links (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id),
            FOREIGN KEY (source_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_id);

        -- Full-text search over title and body. Standalone rather than an
        -- external-content table: the body is not a column anywhere else, it is
        -- extracted from the CRDT at save time.
        CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
            document_id UNINDEXED,
            title,
            body
        );

        CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            local_path TEXT,
            is_fully_downloaded INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS identity (
            user_id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL DEFAULT 'My Device',
            secret_key BLOB
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

fn table_exists(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

/// The schema version `run_migrations` brings a database up to. Bump it in the
/// same change that adds the migration block.
pub const SCHEMA_VERSION: i64 = 4;

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

    // v3: device identity becomes an Ed25519 keypair, and `node_id` becomes the
    // public key rather than a random UUID. Signaling messages are signed from
    // here on, so an identity without a key cannot participate.
    //
    // This is a breaking change to identity, so the old identity row and every
    // pairing built on it are cleared: a pair records a peer's node_id, and
    // every node_id in the system has just changed meaning. Devices re-pair
    // once. Documents are untouched.
    // See docs/decisions/0009-authenticated-signaling.md.
    if version < 3 {
        // Guarded on the table existing, not just the column: a database old
        // enough to predate `identity` should still migrate forward rather than
        // fail. setup_database_tables runs first in production, so this is the
        // belt to that braces.
        if table_exists(db, "identity") {
            let has_secret_key = db
                .prepare("SELECT secret_key FROM identity LIMIT 0")
                .is_ok();
            if !has_secret_key {
                db.execute_batch("ALTER TABLE identity ADD COLUMN secret_key BLOB;")
                    .map_err(|e| format!("Migration v3 failed: {}", e))?;
            }
            db.execute("DELETE FROM identity WHERE secret_key IS NULL", [])
                .map_err(|e| format!("Migration v3 identity reset failed: {}", e))?;
        }
        if table_exists(db, "device_pairs") {
            db.execute("DELETE FROM device_pairs", [])
                .map_err(|e| format!("Migration v3 pairing reset failed: {}", e))?;
        }

        db.execute_batch("PRAGMA user_version = 3;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v4: the link graph and the search index. Both are derived from document
    // content, which only the editor can read, so they are populated as
    // documents are saved rather than backfilled here. Until a document is next
    // saved it simply has no links and no search rows, which is the same state
    // it was in before this existed.
    if version < 4 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_links (
                 source_id TEXT NOT NULL,
                 target_id TEXT NOT NULL,
                 PRIMARY KEY (source_id, target_id),
                 FOREIGN KEY (source_id) REFERENCES documents(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_id);
             CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
                 document_id UNINDEXED,
                 title,
                 body
             );",
        )
        .map_err(|e| format!("Migration v4 failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 4;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    builder
        .setup(|app| {
            let state = AppState::new(app.handle().clone())?;

            {
                let db = state.db.lock();
                setup_database_tables(&db)?;
                run_migrations(&db)?;
            }

            {
                let db = state.db.lock();
                let identity = crate::identity::get_or_create_identity(&db)
                    .map_err(|e| format!("Failed to create identity: {}", e))?;
                state.signaling_manager.set_identity(identity);
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
            list_document_sync_state,
            ensure_document,
            ensure_tombstone,
            apply_remote_rename,
            apply_remote_delete,
            search_documents,
            get_backlinks,
            get_or_create_today_journal,
            get_theme,
            save_theme,
            get_mqtt_broker_url,
            save_mqtt_broker_url,
            save_image,
            import_image_from_path,
            cleanup_orphaned_images,
            request_attachment,
            get_attachment_info,
            get_local_blob_url,
            list_attachment_manifest,
            get_attachment_bytes,
            save_attachment_bytes,
            get_yjs_state,
            save_yjs_update,
            set_content_hash,
            get_identity,
            set_display_name,
            list_paired_devices,
            remove_pair,
            save_pair,
            update_pair_sync_time,
            mqtt_connect,
            mqtt_publish_pair_request,
            mqtt_accept_pair_request,
            mqtt_decline_pair_request,
            mqtt_publish_offer,
            mqtt_publish_answer,
            mqtt_publish_ice_candidate,
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

    // v3 changes what a node_id means: it becomes a public key rather than a
    // random UUID. Every stored pairing records a peer's node_id, so all of
    // them are meaningless afterwards and are cleared. Documents are untouched.
    #[test]
    fn migrating_to_v3_clears_the_keyless_identity_and_its_pairings() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        db.execute_batch(
            "INSERT INTO identity (user_id, node_id, display_name)
                 VALUES ('u1', 'a-random-uuid', 'Laptop');
             INSERT INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
                 VALUES ('u1', 'another-uuid', 'Phone', 'room1');
             INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d1', 'note', 'Keep me', 1, 1);
             UPDATE identity SET secret_key = NULL;
             PRAGMA user_version = 2;",
        )
        .unwrap();

        run_migrations(&db).unwrap();

        let identities: i64 = db
            .query_row("SELECT COUNT(*) FROM identity", [], |r| r.get(0))
            .unwrap();
        let pairs: i64 = db
            .query_row("SELECT COUNT(*) FROM device_pairs", [], |r| r.get(0))
            .unwrap();
        let docs: i64 = db
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
            .unwrap();

        assert_eq!(identities, 0, "the keyless identity is discarded");
        assert_eq!(pairs, 0, "pairings keyed on the old node_id are discarded");
        assert_eq!(docs, 1, "documents must survive the identity reset");

        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    // A device that has already been provisioned with a key must keep it:
    // regenerating would silently break every pairing on every launch.
    #[test]
    fn migrating_to_v3_keeps_an_identity_that_already_has_a_key() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        let me = crate::identity::get_or_create_identity(&db).unwrap();
        db.execute_batch("PRAGMA user_version = 2;").unwrap();

        run_migrations(&db).unwrap();

        let after = crate::identity::get_or_create_identity(&db).unwrap();
        assert_eq!(after.public.node_id, me.public.node_id);
    }

    #[test]
    fn configure_connection_enables_foreign_keys() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();

        let on: i64 = db
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(on, 1, "foreign_keys defaults to OFF and must be turned on");

        let busy: i64 = db
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 5000);
    }

    // The ON DELETE CASCADE declared on yjs_updates and yjs_snapshots never
    // fired, because foreign_keys was off. Nothing hard-deletes a document
    // today (delete_document is a tombstone that clears content explicitly),
    // so this is about the declaration finally meaning what it says.
    #[test]
    fn deleting_a_document_row_cascades_to_its_crdt_data() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();

        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', 1, 1);
             INSERT INTO yjs_updates (document_id, update_blob, created_at)
                 VALUES ('d1', x'0102', 1);
             INSERT INTO yjs_snapshots (document_id, snapshot_blob, last_update_id, updated_at)
                 VALUES ('d1', x'0304', 1, 1);",
        )
        .unwrap();

        db.execute("DELETE FROM documents WHERE id = 'd1'", [])
            .unwrap();

        let updates: i64 = db
            .query_row("SELECT COUNT(*) FROM yjs_updates", [], |r| r.get(0))
            .unwrap();
        let snapshots: i64 = db
            .query_row("SELECT COUNT(*) FROM yjs_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(updates, 0);
        assert_eq!(snapshots, 0);
    }

    // The flip side: content for a document we have never heard of is now
    // refused rather than written as an orphan row that nothing would ever
    // read. The sync layer already catches and logs this; the next manifest
    // exchange materialises the row and pulls the content properly.
    #[test]
    fn crdt_data_for_an_unknown_document_is_refused() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();

        let result = db.execute(
            "INSERT INTO yjs_updates (document_id, update_blob, created_at) VALUES ('ghost', x'01', 1)",
            [],
        );
        assert!(result.is_err(), "an orphan update must not be accepted");
    }

    // Mirrors pairing::save_pair. The transport calls it on every transition to
    // connected, so it must not disturb the sync timestamp of an existing pair.
    #[test]
    fn saving_a_known_pair_keeps_its_last_sync_time() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();

        let upsert = "INSERT INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
                      VALUES (?1, ?2, ?3, ?4)
                      ON CONFLICT(user_id, peer_node_id) DO UPDATE SET
                          peer_display_name = excluded.peer_display_name,
                          room_id           = excluded.room_id";

        db.execute(upsert, rusqlite::params!["u1", "peer1", "Laptop", "room1"])
            .unwrap();
        db.execute(
            "UPDATE device_pairs SET last_synchronized = 12345 WHERE peer_node_id = 'peer1'",
            [],
        )
        .unwrap();

        // Reconnect: same pair saved again, with a renamed device.
        db.execute(
            upsert,
            rusqlite::params!["u1", "peer1", "Laptop Pro", "room1"],
        )
        .unwrap();

        let (name, last): (String, Option<i64>) = db
            .query_row(
                "SELECT peer_display_name, last_synchronized FROM device_pairs WHERE peer_node_id = 'peer1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Laptop Pro", "the display name is refreshed");
        assert_eq!(
            last,
            Some(12345),
            "the sync timestamp survives the reconnect"
        );

        let rows: i64 = db
            .query_row("SELECT COUNT(*) FROM device_pairs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
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
