#[macro_use]
mod logging;

mod commands;
mod crypto;
mod db;
mod endpoints;
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
            lifecycle_updated_at INTEGER,
            index_version INTEGER NOT NULL DEFAULT 0
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

        -- Which documents embed which attachments. The only record of what is
        -- still in use, and therefore the only basis for collecting what is
        -- not. Derived from content, so the editor extracts it on save and the
        -- sync layer on merge, the same way links are.
        CREATE TABLE IF NOT EXISTS document_attachments (
            document_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            PRIMARY KEY (document_id, hash),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_document_attachments_hash ON document_attachments(hash);

        -- One row per task item, in document order. The todo index page reads
        -- every note's and every journal's tasks out of this; `document_index`
        -- only ever held a count. Derived from content, so it is written
        -- wherever content arrives, exactly as links and attachments are.
        --
        -- `ordinal` is the address: an item has no id of its own, and the
        -- whole set is replaced (and so renumbered) on every index pass.
        CREATE TABLE IF NOT EXISTS document_todos (
            document_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            text TEXT NOT NULL,
            checked INTEGER NOT NULL DEFAULT 0,
            depth INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (document_id, ordinal),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        -- Which documents carry which tags. The only record of which tags
        -- exist at all: a tag is offered by the picker because some document
        -- was indexed holding it, so a tag lives exactly as long as the last
        -- chip spelling it and there is no list to curate. Derived from
        -- content, so it is written wherever content arrives, as links and
        -- todos are.
        --
        -- `name` is already normalized by the time it gets here (lower case,
        -- trimmed, no leading hash), which is what makes the primary key the
        -- whole of a tag's identity.
        CREATE TABLE IF NOT EXISTS document_tags (
            document_id TEXT NOT NULL,
            name TEXT NOT NULL,
            PRIMARY KEY (document_id, name),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_document_tags_name ON document_tags(name);

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

        CREATE INDEX IF NOT EXISTS idx_device_pairs_room ON device_pairs(room_id);
        CREATE INDEX IF NOT EXISTS idx_device_pairs_user ON device_pairs(user_id);

        -- Where a device can be reached when it is not on this network: a host
        -- and a port the user typed (ADR 0023). Not a column on device_pairs,
        -- because a device is worth trying at more than one address, and an
        -- address has to exist before the pairing that reaching it creates.
        CREATE TABLE IF NOT EXISTS device_endpoints (
            user_id TEXT NOT NULL,
            peer_node_id TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            last_ok INTEGER,
            PRIMARY KEY (user_id, peer_node_id, host, port)
        );
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
pub const SCHEMA_VERSION: i64 = 9;

/// Additive schema migrations, keyed off `PRAGMA user_version`. Each block runs
/// once and bumps the version. `setup_database_tables` still owns the base
/// `CREATE TABLE IF NOT EXISTS` shape for fresh installs; this only carries
/// existing databases forward.
///
/// The whole run is one transaction. It used to be a sequence of separate
/// statements: a crash between the two `ADD COLUMN`s in v1 left a database
/// that had `content_hash` but not `title_updated_at`, which the v1 guard then
/// skipped on every later launch because it only checks the first column, so
/// every `COALESCE(title_updated_at, ...)` query failed for good. All or
/// nothing is the only sane answer, and SQLite can roll back DDL.
pub fn run_migrations(db: &Connection) -> Result<(), String> {
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);

    // A database written by a newer build of the app. Its schema may have
    // columns and tables this build does not know, and worse, semantics it
    // does not share: writing to it could corrupt what the newer build
    // expects. Refuse rather than guess. This matters for a device that syncs
    // between an updated and a not-yet-updated install of the same app.
    if version > SCHEMA_VERSION {
        return Err(format!(
            "this database is at schema version {version}, newer than this build understands \
             ({SCHEMA_VERSION}). Update the app."
        ));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    db.execute_batch("BEGIN")
        .map_err(|e| format!("Failed to begin the migration: {e}"))?;
    match apply_migrations(db, version) {
        Ok(()) => db
            .execute_batch("COMMIT")
            .map_err(|e| format!("Failed to commit the migration: {e}")),
        Err(e) => {
            // Best effort: if the rollback itself fails there is nothing more
            // to try, and the original error is the one worth reporting.
            let _ = db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

fn apply_migrations(db: &Connection, version: i64) -> Result<(), String> {
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

    // v5: drop the append-only update log. `yjs_updates` and `yjs_snapshots`
    // were written on every save and read by nothing: content is loaded from
    // `documents.crdt_state`, which `save_yjs_update` writes in the same call.
    // The log cost a second full copy of the document per save, accumulating
    // up to fifty before consolidation rewrote it a third time.
    //
    // Their one live use was answering "does this document have content", now
    // a length check on the column that actually holds it.
    if version < 5 {
        db.execute_batch(
            "DROP TABLE IF EXISTS yjs_updates;
             DROP TABLE IF EXISTS yjs_snapshots;",
        )
        .map_err(|e| format!("Migration v5 failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 5;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v6: record which documents embed which attachments, so a blob no
    // document references any more can be identified and collected. Before
    // this there was no way to tell, and `cleanup_orphaned_images` deleted
    // partially-downloaded rows instead, which nothing ever creates.
    //
    // `index_version` says whether a document's derived rows were built by a
    // version of the indexer that records attachments. Collection is unsafe
    // until every document has been, or it would delete blobs belonging to
    // documents it simply has not looked at.
    if version < 6 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_attachments (
                 document_id TEXT NOT NULL,
                 hash TEXT NOT NULL,
                 PRIMARY KEY (document_id, hash),
                 FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_document_attachments_hash
                 ON document_attachments(hash);",
        )
        .map_err(|e| format!("Migration v6 failed: {}", e))?;

        let has_index_version = db
            .prepare("SELECT index_version FROM documents LIMIT 0")
            .is_ok();
        if !has_index_version {
            db.execute_batch(
                "ALTER TABLE documents ADD COLUMN index_version INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("Migration v6 index_version failed: {}", e))?;
        }

        db.execute_batch("PRAGMA user_version = 6;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v7: the todos themselves, not just a count of them. Nothing is
    // backfilled here, because the rows are read out of rendered content that
    // only the indexer can see; bumping `indexer::INDEX_VERSION` in the same
    // change is what makes the startup backfill revisit every document.
    if version < 7 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_todos (
                 document_id TEXT NOT NULL,
                 ordinal INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 checked INTEGER NOT NULL DEFAULT 0,
                 depth INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (document_id, ordinal),
                 FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
             );",
        )
        .map_err(|e| format!("Migration v7 failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 7;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v8: the tags a document carries. Nothing is backfilled, and
    // `indexer::INDEX_VERSION` is deliberately not bumped with it: a tag is a
    // node type that did not exist before this build, so no document written by
    // any earlier one can contain one. There is nothing for a re-render of the
    // corpus to find, and a bump would also stall attachment collection until
    // it finished.
    if version < 8 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS document_tags (
                 document_id TEXT NOT NULL,
                 name TEXT NOT NULL,
                 PRIMARY KEY (document_id, name),
                 FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_document_tags_name ON document_tags(name);",
        )
        .map_err(|e| format!("Migration v8 failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 8;")
            .map_err(|e| format!("Failed to set user_version: {}", e))?;
    }

    // v9: the addresses a device can be reached at when it is not on this
    // network (ADR 0023). Nothing is backfilled, because there was nowhere for
    // an address to have been written before this table existed.
    if version < 9 {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS device_endpoints (
                 user_id TEXT NOT NULL,
                 peer_node_id TEXT NOT NULL,
                 host TEXT NOT NULL,
                 port INTEGER NOT NULL,
                 added_at INTEGER NOT NULL,
                 last_ok INTEGER,
                 PRIMARY KEY (user_id, peer_node_id, host, port)
             );",
        )
        .map_err(|e| format!("Migration v9 failed: {}", e))?;

        db.execute_batch("PRAGMA user_version = 9;")
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
            get_all_todos,
            get_all_tags,
            get_documents_by_tag,
            get_document_tags,
            get_tag_count,
            get_or_create_today_journal,
            get_theme,
            save_theme,
            save_image,
            pick_and_import_image,
            cleanup_orphaned_images,
            list_unindexed_documents,
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
            save_peer_endpoint,
            forget_peer_endpoint,
            list_peer_endpoints,
            remove_pair,
            save_pair,
            update_pair_sync_time,
            signaling_publish_pair_request,
            signaling_accept_pair_request,
            signaling_decline_pair_request,
            signaling_publish_offer,
            signaling_publish_answer,
            signaling_publish_ice_candidate,
            signaling_start,
            signaling_stop,
            probe_stored_addresses,
            list_reachable_peers,
            list_export_attachments,
            export_notes,
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

    // A database from a newer build may have semantics this one does not
    // share, so writing to it risks corrupting what that build expects.
    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        db.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
            .unwrap();

        let err = run_migrations(&db).expect_err("must refuse");
        assert!(err.contains("newer than this build"), "got {err}");
    }

    #[test]
    fn an_up_to_date_database_needs_no_work() {
        let db = Connection::open_in_memory().unwrap();
        setup_database_tables(&db).unwrap();
        run_migrations(&db).unwrap();
        // Second run takes the early return rather than re-running anything.
        run_migrations(&db).unwrap();
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    // The regression: a crash between the two ADD COLUMNs in v1 left a
    // database with `content_hash` but not `title_updated_at`. The v1 guard
    // only checks the first, so it skipped the block on every later launch
    // and every COALESCE(title_updated_at, ...) query failed for good.
    #[test]
    fn a_failed_migration_leaves_the_schema_untouched() {
        let db = legacy_db();
        // Occupy the name the v4 migration needs, with an incompatible shape,
        // so that migration fails partway through the run.
        db.execute_batch("CREATE TABLE document_links (nope INTEGER);")
            .unwrap();

        assert!(run_migrations(&db).is_err(), "the run must fail");

        // v1 would have added these had it committed.
        assert!(
            !column_exists(&db, "content_hash"),
            "a failed run must roll back every earlier step"
        );
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 0, "and must not claim to have progressed");
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

    // `ON DELETE CASCADE` never fired anywhere, because foreign_keys was off.
    // `document_links` is where it still matters now that the update log is
    // gone: a hard-deleted document must not leave edges behind pointing out
    // of a row that no longer exists.
    #[test]
    fn deleting_a_document_row_cascades_to_its_links() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();

        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', 1, 1), ('d2', 'note', 'Two', 1, 1);
             INSERT INTO document_links (source_id, target_id) VALUES ('d1', 'd2');",
        )
        .unwrap();

        db.execute("DELETE FROM documents WHERE id = 'd1'", [])
            .unwrap();

        let links: i64 = db
            .query_row("SELECT COUNT(*) FROM document_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(links, 0);
    }

    // The flip side: an edge out of a document we have never heard of is
    // refused rather than written as an orphan row.
    #[test]
    fn a_link_from_an_unknown_document_is_refused() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d2', 'note', 'Two', 1, 1)",
            [],
        )
        .unwrap();

        let result = db.execute(
            "INSERT INTO document_links (source_id, target_id) VALUES ('ghost', 'd2')",
            [],
        );
        assert!(result.is_err(), "an orphan link must not be accepted");
    }

    // v5 retires the append-only update log. Nothing read it: content is
    // loaded from `documents.crdt_state`, written by the same call that used
    // to append to the log.
    #[test]
    fn migrating_to_v5_drops_the_update_log_and_keeps_the_content() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();
        // Recreate the v4 shape, since the base schema no longer has it.
        db.execute_batch(
            "CREATE TABLE yjs_updates (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 document_id TEXT NOT NULL,
                 update_blob BLOB NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE yjs_snapshots (
                 document_id TEXT PRIMARY KEY NOT NULL,
                 snapshot_blob BLOB NOT NULL,
                 last_update_id INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', x'0102', 1, 1);
             INSERT INTO yjs_updates (document_id, update_blob, created_at)
                 VALUES ('d1', x'0102', 1);
             PRAGMA user_version = 4;",
        )
        .unwrap();

        run_migrations(&db).unwrap();

        assert!(!table_exists(&db, "yjs_updates"));
        assert!(!table_exists(&db, "yjs_snapshots"));

        let state: Option<Vec<u8>> = db
            .query_row(
                "SELECT crdt_state FROM documents WHERE id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            state,
            Some(vec![1, 2]),
            "the log was the redundant copy, not the content"
        );
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

    // A database that already has attachments but no todo table, which is
    // every install shipped before the todo index.
    #[test]
    fn migrates_v6_to_v7_and_adds_the_todo_table() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();
        db.execute_batch("DROP TABLE document_todos; PRAGMA user_version = 6;")
            .unwrap();

        run_migrations(&db).unwrap();

        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', 1, 1);
             INSERT INTO document_todos (document_id, ordinal, text, checked, depth)
                 VALUES ('d1', 0, 'buy milk', 0, 0);",
        )
        .unwrap();

        // The cascade is what takes a deleted note's todos off the index page.
        db.execute("DELETE FROM documents WHERE id = 'd1'", [])
            .unwrap();
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM document_todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    // A database from before tags existed, which is every install shipped so
    // far. Nothing is backfilled: no earlier build could write a tag, so an
    // empty table is the whole truth about what the corpus is tagged with.
    #[test]
    fn migrates_v7_to_v8_and_adds_the_tag_table() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        setup_database_tables(&db).unwrap();
        db.execute_batch("DROP TABLE document_tags; PRAGMA user_version = 7;")
            .unwrap();

        run_migrations(&db).unwrap();

        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', 1, 1);
             INSERT INTO document_tags (document_id, name) VALUES ('d1', 'work');",
        )
        .unwrap();

        // A tag is only ever offered because a live document carries it, so the
        // rows must go when the document does.
        db.execute("DELETE FROM documents WHERE id = 'd1'", [])
            .unwrap();
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM document_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
