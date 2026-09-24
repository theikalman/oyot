//! Reading the library as it stood at one instant.

use super::format::{BackupDocument, Preferences};
use crate::commands::attachments::referenced_attachments;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Open a second, read-only connection to the database, for one backup.
///
/// The app's own connection sits behind a mutex that every save takes, and a
/// backup reads every document, which on a large library is long enough for
/// the editor to notice waiting. The database is in WAL mode, so a read
/// transaction on a connection of its own sees one consistent snapshot while
/// writes carry on through the other: the backup is of one instant, and
/// nobody waits for it.
pub fn open_snapshot(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("could not open the database to back it up: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")
        .map_err(|e| format!("could not configure the backup connection: {e}"))?;
    Ok(conn)
}

/// One document as the snapshot found it.
pub(crate) struct DocumentRow {
    /// Everything `documents.json` records, with `state` not yet assigned.
    pub document: BackupDocument,
    /// The sync layer's change detector, when one has been computed.
    pub content_hash: Option<Vec<u8>>,
    /// Whether there is content to write: the document is live and holds
    /// more than an empty Yjs document, which still encodes to two bytes.
    pub has_state: bool,
}

pub(crate) struct AttachmentRow {
    pub hash: String,
    pub mime_type: String,
    /// Relative to the app's data directory.
    pub local_path: String,
}

pub(crate) struct LibrarySnapshot {
    /// Every row, tombstones included, ordered by id.
    pub documents: Vec<DocumentRow>,
    /// Ordered by hash.
    pub attachments: Vec<AttachmentRow>,
    pub device_name: Option<String>,
}

/// Read everything a backup is made of.
///
/// The caller holds the read transaction that makes this one instant: the
/// documents and the attachments they embed are two queries, and a save
/// landing between them would otherwise pair one moment's documents with
/// another moment's images.
pub(crate) fn read_snapshot(conn: &Connection) -> Result<LibrarySnapshot, String> {
    // The stamps are resolved exactly as `list_document_sync_state` resolves
    // them for a peer, so a backup advertises what this device would. Keep
    // the two in step.
    let mut stmt = conn
        .prepare(
            "SELECT id, type, title, created_at, updated_at, \
                    COALESCE(title_updated_at, updated_at), is_deleted, deleted_at, \
                    COALESCE(lifecycle_updated_at, deleted_at, title_updated_at, updated_at, created_at), \
                    content_hash, \
                    is_deleted = 0 AND COALESCE(length(crdt_state), 0) > 2, \
                    pinned, pinned_updated_at \
             FROM documents ORDER BY id",
        )
        .map_err(|e| format!("could not read the documents: {e}"))?;

    // Unlike the manifest query, a row that fails to read fails the backup.
    // Skipping it would produce a backup that is quietly missing a note,
    // which is the one thing a backup must not be.
    let documents = stmt
        .query_map([], |row| {
            Ok(DocumentRow {
                document: BackupDocument {
                    id: row.get(0)?,
                    doc_type: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    title_updated_at: row.get(5)?,
                    is_deleted: row.get::<_, i64>(6)? != 0,
                    deleted_at: row.get(7)?,
                    lifecycle_updated_at: row.get(8)?,
                    pinned: row.get::<_, i64>(11)? != 0,
                    pinned_updated_at: row.get(12)?,
                    state: None,
                },
                content_hash: row.get(9)?,
                has_state: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|e| format!("could not read the documents: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read a document: {e}"))?;

    // The same set `list_attachment_manifest` advertises to a peer and the
    // export writes: held in full, and embedded by a live document.
    let mut attachments: Vec<AttachmentRow> = referenced_attachments(conn)?
        .into_iter()
        .map(|(hash, mime_type, local_path)| AttachmentRow {
            hash,
            mime_type,
            local_path,
        })
        .collect();
    attachments.sort_by(|a, b| a.hash.cmp(&b.hash));

    // Only the name. The identity row also holds this device's signing key,
    // which never goes into a backup (ADR 0024, decision 2).
    let device_name = conn
        .query_row(
            "SELECT display_name FROM identity ORDER BY rowid LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("could not read this device's name: {e}"))?;

    Ok(LibrarySnapshot {
        documents,
        attachments,
        device_name,
    })
}

/// A digest of everything a backup of this snapshot would contain, except the
/// moment it was taken and the device that took it.
///
/// Two snapshots with the same fingerprint back up to the same library. A
/// scheduled backup uses this to skip a library that has not changed since
/// the last one (ADR 0026). It covers the change detector rather than the
/// content itself, so it can be computed without reading a single document.
pub(crate) fn fingerprint(
    snapshot: &LibrarySnapshot,
    preferences: &Preferences,
) -> Result<String, String> {
    #[derive(Serialize)]
    struct Document<'a> {
        document: &'a BackupDocument,
        content_hash: Option<String>,
        has_state: bool,
    }

    #[derive(Serialize)]
    struct Input<'a> {
        /// Changing what goes into the digest changes this, so an old
        /// fingerprint never compares equal to a new one by accident.
        scheme: &'static str,
        documents: Vec<Document<'a>>,
        attachments: Vec<&'a str>,
        preferences: &'a Preferences,
    }

    let input = Input {
        scheme: "oyot-backup-fingerprint/1",
        documents: snapshot
            .documents
            .iter()
            .map(|row| Document {
                document: &row.document,
                content_hash: row.content_hash.as_deref().map(hex::encode),
                has_state: row.has_state,
            })
            .collect(),
        attachments: snapshot
            .attachments
            .iter()
            .map(|a| a.hash.as_str())
            .collect(),
        preferences,
    };
    let bytes = serde_json::to_vec(&input)
        .map_err(|e| format!("could not fingerprint the library: {e}"))?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

/// The fingerprint of the library as it stands, without writing a backup.
// The scheduler's skip-if-unchanged check (ADR 0026) is its caller, and it has
// not landed yet; until then only the tests call it.
#[allow(dead_code)]
pub fn library_fingerprint(conn: &Connection, preferences: &Preferences) -> Result<String, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start reading the library: {e}"))?;
    let snapshot = read_snapshot(&tx)?;
    fingerprint(&snapshot, preferences)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn fingerprint_of(db: &Connection) -> String {
        library_fingerprint(db, &Preferences::default()).unwrap()
    }

    #[test]
    fn resolves_the_stamps_as_the_sync_manifest_does() {
        let db = library();
        // A row from before either stamp existed: both fall back.
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('old', 'note', 'Old', 10, 20)",
            [],
        )
        .unwrap();
        // A tombstone without a lifecycle stamp falls back to its delete.
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at, is_deleted, deleted_at)
                 VALUES ('gone', 'note', 'Gone', 10, 20, 1, 30)",
            [],
        )
        .unwrap();

        let snapshot = read_snapshot(&db).unwrap();
        let old = &snapshot.documents[1].document;
        assert_eq!(old.id, "old");
        assert_eq!(old.title_updated_at, 20);
        assert_eq!(old.lifecycle_updated_at, 20);

        let gone = &snapshot.documents[0].document;
        assert_eq!(gone.id, "gone");
        assert!(gone.is_deleted);
        assert_eq!(gone.lifecycle_updated_at, 30);
    }

    #[test]
    fn only_a_live_document_with_content_has_state_to_write() {
        let db = library();
        add_document(&db, "a-live", b"some yjs state");
        add_document(&db, "b-empty", &[0, 0]);
        db.execute(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at, is_deleted, deleted_at)
                 VALUES ('c-deleted', 'note', 'Deleted', x'01020304', 1, 1, 1, 5)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('d-never-typed', 'note', 'Untitled', 1, 1)",
            [],
        )
        .unwrap();

        let snapshot = read_snapshot(&db).unwrap();
        let has_state: Vec<(&str, bool)> = snapshot
            .documents
            .iter()
            .map(|row| (row.document.id.as_str(), row.has_state))
            .collect();
        assert_eq!(
            has_state,
            vec![
                ("a-live", true),
                ("b-empty", false),
                ("c-deleted", false),
                ("d-never-typed", false),
            ]
        );
    }

    #[test]
    fn reads_the_device_name_and_nothing_else_of_the_identity() {
        let db = library();
        assert_eq!(read_snapshot(&db).unwrap().device_name, None);
        add_identity(&db, "Kitchen laptop");
        assert_eq!(
            read_snapshot(&db).unwrap().device_name.as_deref(),
            Some("Kitchen laptop")
        );
    }

    #[test]
    fn the_fingerprint_is_stable_for_an_unchanged_library() {
        let db = library();
        add_document(&db, "a", b"state");
        assert_eq!(fingerprint_of(&db), fingerprint_of(&db));
    }

    #[test]
    fn the_fingerprint_moves_with_everything_a_backup_would_carry() {
        let data = scratch();
        let db = library();
        add_document(&db, "a", b"state");
        let mut seen = vec![fingerprint_of(&db)];
        let mut changed = |db: &Connection, what: &str| {
            let now = fingerprint_of(db);
            assert!(!seen.contains(&now), "{what} should change the fingerprint");
            seen.push(now);
        };

        db.execute(
            "UPDATE documents SET content_hash = x'aa' WHERE id = 'a'",
            [],
        )
        .unwrap();
        changed(&db, "an edit");

        db.execute(
            "UPDATE documents SET title = 'Renamed', title_updated_at = 99 WHERE id = 'a'",
            [],
        )
        .unwrap();
        changed(&db, "a rename");

        crate::commands::documents::set_pinned(&db, "a", true, 100).unwrap();
        changed(&db, "a pin");

        crate::commands::documents::set_pinned(&db, "a", false, 101).unwrap();
        changed(&db, "an unpin");

        add_document(&db, "b", b"more");
        changed(&db, "a new document");

        add_attachment(&db, &data, "a", &png(b"one"));
        changed(&db, "an image arriving");

        crate::commands::documents::tombstone_document(&db, "b", 100).unwrap();
        changed(&db, "a delete");

        let dark = Preferences {
            theme: Some("dark".to_string()),
        };
        let with_theme = library_fingerprint(&db, &dark).unwrap();
        assert!(!seen.contains(&with_theme), "a preference should change it");
    }

    #[test]
    fn the_fingerprint_ignores_who_took_the_backup() {
        let db = library();
        add_document(&db, "a", b"state");
        add_identity(&db, "Desk");
        let before = fingerprint_of(&db);
        crate::identity::update_display_name(&db, "Renamed desk").unwrap();
        assert_eq!(fingerprint_of(&db), before);
    }

    // The whole reason for a second connection. If this stopped holding - the
    // database left WAL mode, say - a backup would pair one moment's documents
    // with another's images, and the editor would wait on every backup.
    #[test]
    fn a_snapshot_connection_sees_one_instant_while_writes_continue() {
        let dir = scratch();
        let path = dir.join("oyot.db");
        let main = Connection::open(&path).unwrap();
        crate::db::configure_connection(&main).unwrap();
        crate::setup_database_tables(&main).unwrap();
        add_document(&main, "first", b"state");

        let snapshot = open_snapshot(&path).unwrap();
        let tx = snapshot.unchecked_transaction().unwrap();
        let count = |conn: &Connection| -> i64 {
            conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(count(&tx), 1);

        // The app keeps saving while the backup reads.
        add_document(&main, "second", b"state");
        assert_eq!(count(&main), 2);
        assert_eq!(count(&tx), 1, "the backup must not see a later write");

        drop(tx);
        assert_eq!(count(&snapshot), 2);

        // And it cannot write, whatever it is asked to do.
        assert!(snapshot.execute("DELETE FROM documents", []).is_err());

        drop(snapshot);
        drop(main);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
