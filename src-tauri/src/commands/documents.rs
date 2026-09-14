use crate::db::AppState;
use crate::indexer;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title_updated_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub lifecycle_updated_at: i64,
}

// Column list backing `row_to_document`; keep the two in lockstep.
//
// Deliberately without `crdt_state` and `content_hash`. Both are blobs, both
// serialise to IPC as a JSON array of numbers at roughly 3.6 bytes per byte,
// and neither has a reader: the editor gets its state from `get_yjs_state`
// (base64, and registered as the open copy in the same step) and the sync
// manifest carries its own base64 hash on `DocSyncEntry`. Sending them here
// meant every click in the sidebar shipped several times the document's size
// for nothing.
const DOCUMENT_COLUMNS: &str = "id, type, title, created_at, updated_at, \
     COALESCE(title_updated_at, updated_at), is_deleted, deleted_at, \
     COALESCE(lifecycle_updated_at, deleted_at, title_updated_at, updated_at, created_at)";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DocumentSummary {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub todo_count: i32,
    pub completed_todo_count: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_content: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexData {
    pub documents: Vec<DocumentSummary>,
}

pub fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn format_journal_date(date_str: &str) -> Option<String> {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: u32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;

    let month_names = [
        "", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month_name = month_names.get(month as usize)?;

    Some(format!("{} {} {}", day, month_name, year))
}

pub fn get_today_date() -> String {
    let now = chrono::Local::now();
    now.format("%Y-%m-%d").to_string()
}

fn row_to_document_summary(row: &rusqlite::Row) -> rusqlite::Result<DocumentSummary> {
    let has_content_int: i32 = row.get(7)?;
    Ok(DocumentSummary {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        todo_count: row.get(3)?,
        completed_todo_count: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        has_content: has_content_int != 0,
    })
}

fn row_to_document(row: &rusqlite::Row) -> rusqlite::Result<Document> {
    let is_deleted_int: i64 = row.get(6)?;
    Ok(Document {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        title_updated_at: row.get(5)?,
        is_deleted: is_deleted_int != 0,
        deleted_at: row.get(7)?,
        lifecycle_updated_at: row.get(8)?,
    })
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn query_all_documents(db: &rusqlite::Connection) -> Result<IndexData, String> {
    let content_filter = "AND (EXISTS (SELECT 1 FROM yjs_updates u WHERE u.document_id = d.id)
              OR EXISTS (SELECT 1 FROM yjs_snapshots s WHERE s.document_id = d.id))";
    let sql = format!(
        "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at,
                CASE WHEN EXISTS (SELECT 1 FROM yjs_updates u WHERE u.document_id = d.id)
                       OR EXISTS (SELECT 1 FROM yjs_snapshots s WHERE s.document_id = d.id)
                     THEN 1 ELSE 0 END as has_content
         FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0 {content_filter}
         ORDER BY d.created_at DESC"
    );
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let documents: Vec<DocumentSummary> = stmt
        .query_map([], row_to_document_summary)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(IndexData { documents })
}

#[tauri::command]
pub fn get_all_documents(state: tauri::State<'_, AppState>) -> Result<IndexData, String> {
    let db = state.db.lock();
    query_all_documents(&db)
}

#[tauri::command]
pub fn get_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<Document, String> {
    let db = state.db.lock();
    db.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND is_deleted = 0"),
        params![doc_id],
        row_to_document,
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DocSyncEntry {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title_updated_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub lifecycle_updated_at: i64,
    /// base64 of the content hash, matching how it crosses IPC elsewhere.
    pub content_hash: Option<String>,
}

// The full document manifest a paired device sends on connect so the peer can
// reconcile its entire document set: every row including tombstones, each with a
// `content_hash` (change detector) and `title_updated_at` (last-writer-wins on
// rename). Unlike get_all_documents this is not scoped to the sidebar and does
// not filter out content-less or deleted rows.
// See docs/decisions/0003-full-document-set-sync.md.
#[tauri::command]
pub fn list_document_sync_state(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DocSyncEntry>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, type, title, created_at, updated_at, \
                    COALESCE(title_updated_at, updated_at), is_deleted, deleted_at, \
                    COALESCE(lifecycle_updated_at, deleted_at, title_updated_at, updated_at, created_at), \
                    content_hash \
             FROM documents",
        )
        .map_err(|e| e.to_string())?;

    let entries: Vec<DocSyncEntry> = stmt
        .query_map([], |row| {
            let is_deleted_int: i64 = row.get(6)?;
            Ok(DocSyncEntry {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                title_updated_at: row.get(5)?,
                is_deleted: is_deleted_int != 0,
                deleted_at: row.get(7)?,
                lifecycle_updated_at: row.get(8)?,
                content_hash: row.get::<_, Option<Vec<u8>>>(9)?.map(|h| BASE64.encode(h)),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

// One document as a peer advertised it. Mirrors the frontend `ManifestEntry`;
// grouped into a struct rather than passed as eight positional arguments.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureDocumentRequest {
    pub doc_id: String,
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title_updated_at: Option<i64>,
    pub lifecycle_updated_at: Option<i64>,
}

// Idempotently materializes a document row learned about from a peer (via
// list_document_metadata or a live doc-created broadcast) so that a subsequent
// save_yjs_update for this doc_id has a row to attach content to. Never
// overwrites an existing row - if we already know this document, whatever we
// have locally wins over the peer's metadata snapshot.
#[tauri::command]
pub fn ensure_document(
    state: tauri::State<'_, AppState>,
    entry: EnsureDocumentRequest,
) -> Result<Document, String> {
    let EnsureDocumentRequest {
        doc_id,
        doc_type,
        title,
        created_at,
        updated_at,
        title_updated_at,
        lifecycle_updated_at,
    } = entry;
    let title_updated_at = title_updated_at.unwrap_or(updated_at);
    let lifecycle_updated_at = lifecycle_updated_at.unwrap_or(created_at);
    {
        let db = state.db.lock();
        // Insert what we do not have, and clear a local tombstone only when the
        // peer's lifecycle stamp is newer than ours. Title and created_at are
        // never overwritten here: apply_remote_rename owns the title, and the
        // local row is authoritative for its own creation time.
        db.execute(
            "INSERT INTO documents
                 (id, type, title, created_at, updated_at, title_updated_at,
                  is_deleted, deleted_at, lifecycle_updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 is_deleted           = 0,
                 deleted_at           = NULL,
                 lifecycle_updated_at = excluded.lifecycle_updated_at
             WHERE documents.is_deleted = 1
               AND (documents.lifecycle_updated_at IS NULL
                    OR documents.lifecycle_updated_at < excluded.lifecycle_updated_at)",
            params![
                &doc_id,
                &doc_type,
                &title,
                created_at,
                updated_at,
                title_updated_at,
                lifecycle_updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        indexer::update_document_title(&db, &doc_id, &title)?;
    }

    get_document(state, doc_id)
}

// Applies a peer's rename, last-writer-wins on `title_updated_at`: an older or
// equal stamp is ignored so the two devices converge on the same title without a
// central clock. Returns true if the local row changed.
#[tauri::command]
pub fn apply_remote_rename(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    title: String,
    title_updated_at: i64,
) -> Result<bool, String> {
    let db = state.db.lock();
    let changed = db
        .execute(
            "UPDATE documents SET title = ?1, title_updated_at = ?2 \
             WHERE id = ?3 AND (title_updated_at IS NULL OR title_updated_at < ?2)",
            params![&title, title_updated_at, &doc_id],
        )
        .map_err(|e| e.to_string())?;
    if changed > 0 {
        indexer::update_document_title(&db, &doc_id, &title)?;
    }
    Ok(changed > 0)
}

// Applies a peer's deletion as a tombstone (the row is kept so the delete keeps
// propagating). Idempotent; also drops the CRDT history like a local delete.
// Returns true if the local row changed, i.e. the peer's tombstone was the
// later observation. A losing tombstone leaves the document alone.
#[tauri::command]
pub fn apply_remote_delete(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    deleted_at: i64,
) -> Result<bool, String> {
    let applied = {
        let db = state.db.lock();
        apply_tombstone_if_newer(&db, &doc_id, deleted_at)?
    };

    // Only drop the update log if the tombstone actually won. Doing it
    // unconditionally would empty a document whose revival we had already
    // accepted, while leaving the row live.
    if applied {
        state.snapshot.delete_document_data(&doc_id)?;
    }
    Ok(applied)
}

#[tauri::command]
pub fn create_document(
    state: tauri::State<'_, AppState>,
    doc_type: String,
    title: String,
) -> Result<Document, String> {
    // Journal ids are derived from the date so two devices creating the same
    // day's entry converge on one row. That also means a deleted journal's
    // tombstone still holds the id, so a plain INSERT would fail the primary
    // key. Revive it instead.
    let doc_id = if doc_type == "journal" {
        format_journal_date(&title).unwrap_or_else(|| title.clone())
    } else {
        uuid_v4()
    };
    let now = current_timestamp();

    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents
                 (id, type, title, created_at, updated_at, title_updated_at,
                  is_deleted, deleted_at, lifecycle_updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4, 0, NULL, ?4)
             ON CONFLICT(id) DO UPDATE SET
                 is_deleted           = 0,
                 deleted_at           = NULL,
                 updated_at           = excluded.updated_at,
                 lifecycle_updated_at = excluded.lifecycle_updated_at",
            params![&doc_id, &doc_type, &title, now],
        )
        .map_err(|e| e.to_string())?;
    }

    {
        let db = state.db.lock();
        indexer::update_document_title(&db, &doc_id, &title)?;
    }

    get_document(state, doc_id)
}

#[tauri::command]
pub fn update_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    title: String,
) -> Result<Document, String> {
    let now = current_timestamp();
    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET title = ?, updated_at = ?, title_updated_at = ? WHERE id = ? AND is_deleted = 0",
            params![&title, now, now, &doc_id],
        )
        .map_err(|e| e.to_string())?;
    }

    {
        let db = state.db.lock();
        indexer::update_document_title(&db, &doc_id, &title)?;
    }

    get_document(state, doc_id)
}

// Deleting is a tombstone plus the loss of the content.
//
// Both delete paths used to leave `crdt_state` in place, and it is the only
// column anything reads content from: `delete_document_data` clears the update
// log, which nothing loads. So a revived document came back with everything
// still in it. ADR 0003 decision 5 and ADR 0008 both say the history is
// dropped; the code was what disagreed, and the visible consequence was that
// deleting today's journal did not clear it, since the next launch revives it.
//
// Clearing `content_hash` with it keeps the manifest honest: a tombstone with a
// stale hash would advertise content this device no longer has.
const TOMBSTONE_SET: &str = "is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1, \
     crdt_state = NULL, content_hash = NULL";

/// Tombstone a document locally. Takes `&Connection` rather than `State` so the
/// behaviour can be tested rather than mirrored by a copy of the SQL.
pub fn tombstone_document(db: &Connection, doc_id: &str, now: i64) -> Result<(), String> {
    db.execute(
        &format!("UPDATE documents SET {TOMBSTONE_SET} WHERE id = ?2"),
        params![now, doc_id],
    )
    .map_err(|e| e.to_string())?;
    indexer::clear_document_index(db, doc_id)
}

/// Apply a peer's tombstone, last-writer-wins on the lifecycle stamp. Returns
/// whether it applied: a stale tombstone must not undo a later revival, and
/// must not take the revived content with it.
pub fn apply_tombstone_if_newer(
    db: &Connection,
    doc_id: &str,
    deleted_at: i64,
) -> Result<bool, String> {
    let applied = db
        .execute(
            &format!(
                "UPDATE documents SET {TOMBSTONE_SET}
                  WHERE id = ?2
                    AND (lifecycle_updated_at IS NULL OR lifecycle_updated_at < ?1)"
            ),
            params![deleted_at, doc_id],
        )
        .map_err(|e| e.to_string())?;
    if applied > 0 {
        indexer::clear_document_index(db, doc_id)?;
    }
    Ok(applied > 0)
}

/// Returns the timestamp written, so the broadcast to peers carries the same
/// stamp the row does. Inventing a second one with `Date.now()` on the way out
/// made every peer record a delete marginally later than ours, which the next
/// manifest exchange then applied back to us as if it were news.
#[tauri::command]
pub fn delete_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<i64, String> {
    let now = current_timestamp();
    {
        let db = state.db.lock();
        tombstone_document(&db, &doc_id, now)?;
    }
    state.snapshot.delete_document_data(&doc_id)?;
    Ok(now)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchHit {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    /// A fragment of the body around the match, with the matched terms marked
    /// by [ and ]. Empty when the match was in the title only.
    pub snippet: String,
}

/// Full-text search over titles and bodies.
///
/// Previously a `LIKE '%q%'` over titles alone, which could not find anything
/// the user had actually written. Bodies are indexed at save time (see
/// `indexer`), because document content lives in the CRDT and is not otherwise
/// queryable.
#[tauri::command]
pub fn search_documents(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let Some(match_query) = indexer::to_fts_query(&query) else {
        return Ok(Vec::new());
    };

    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT d.id, d.type, d.title,
                    snippet(document_search, 2, '[', ']', '…', 12) AS snippet
               FROM document_search
               JOIN documents d ON d.id = document_search.document_id
              WHERE document_search MATCH ?1
                AND d.is_deleted = 0
              ORDER BY rank
              LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let results: Vec<SearchHit> = stmt
        .query_map(params![&match_query], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                snippet: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Documents that link to `doc_id`.
///
/// This used to take a `_target_title` it ignored and return every non-deleted
/// document, which made it look implemented while being a stub. It now reads
/// the edge table the editor maintains on save.
#[tauri::command]
pub fn get_backlinks(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<Vec<DocumentSummary>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at,
                    CASE WHEN EXISTS (SELECT 1 FROM yjs_updates u WHERE u.document_id = d.id)
                           OR EXISTS (SELECT 1 FROM yjs_snapshots s WHERE s.document_id = d.id)
                         THEN 1 ELSE 0 END as has_content
               FROM document_links l
               JOIN documents d ON d.id = l.source_id
               LEFT JOIN document_index i ON d.id = i.document_id
              WHERE l.target_id = ?1
                AND d.is_deleted = 0
              ORDER BY d.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let backlinks: Vec<DocumentSummary> = stmt
        .query_map(params![&doc_id], row_to_document_summary)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(backlinks)
}

#[tauri::command]
pub fn get_or_create_today_journal(state: tauri::State<'_, AppState>) -> Result<Document, String> {
    let today_title = get_today_date();
    let doc_id = format_journal_date(&today_title).unwrap_or_else(|| today_title.clone());

    let now = current_timestamp();

    // One upsert rather than SELECT-then-INSERT: the old form released the
    // mutex between the two, and failed outright once the day's journal had
    // been deleted, because the tombstone still owned the id. Failing here took
    // the whole app down with it, since startup awaits this before it can show
    // a document.
    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents
                 (id, type, title, created_at, updated_at, title_updated_at,
                  is_deleted, deleted_at, lifecycle_updated_at)
             VALUES (?1, 'journal', ?2, ?3, ?3, ?3, 0, NULL, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 is_deleted           = 0,
                 deleted_at           = NULL,
                 lifecycle_updated_at = CASE
                     WHEN documents.is_deleted = 1 THEN excluded.lifecycle_updated_at
                     ELSE documents.lifecycle_updated_at
                 END",
            params![&doc_id, &today_title, now],
        )
        .map_err(|e| e.to_string())?;

        indexer::update_document_title(&db, &doc_id, &today_title)?;
    }

    get_document(state, doc_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises the real functions rather than a copy of their SQL. The
    // migration tests in lib.rs mirror statements by hand, which means they
    // pass whatever the code does.
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        crate::setup_database_tables(&db).unwrap();
        db.execute(
            "INSERT INTO documents
                 (id, type, title, crdt_state, content_hash, created_at, updated_at,
                  title_updated_at, is_deleted, lifecycle_updated_at)
             VALUES ('d1', 'note', 'One', x'0102', x'0304', 1, 1, 1, 0, 500)",
            [],
        )
        .unwrap();
        db
    }

    fn content(db: &Connection) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
        db.query_row(
            "SELECT crdt_state, content_hash FROM documents WHERE id = 'd1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    // The regression: both delete paths cleared the update log, which nothing
    // reads, and left `crdt_state`, which is the only column content is loaded
    // from. A revived document therefore came back with everything still in
    // it, and deleting today's journal did not clear it because the next
    // launch revives it.
    #[test]
    fn deleting_drops_the_content_not_just_the_flag() {
        let db = db();
        tombstone_document(&db, "d1", 900).unwrap();

        let (state, hash) = content(&db);
        assert_eq!(state, None, "the content must go with the tombstone");
        assert_eq!(hash, None, "a stale hash would advertise content we lost");

        let (deleted, stamp): (i64, i64) = db
            .query_row(
                "SELECT is_deleted, lifecycle_updated_at FROM documents WHERE id = 'd1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(stamp, 900);
    }

    #[test]
    fn deleting_clears_the_derived_rows() {
        let db = db();
        crate::indexer::update_document_index(
            &db,
            "d1",
            "One",
            &crate::indexer::DocumentIndexInput {
                text: "findable".into(),
                link_targets: vec![],
                todo_count: 0,
                completed_todo_count: 0,
            },
        )
        .unwrap();

        tombstone_document(&db, "d1", 900).unwrap();

        let rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM document_search WHERE document_id = 'd1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "a deleted document must not stay searchable");
    }

    #[test]
    fn a_remote_tombstone_older_than_our_revival_changes_nothing() {
        let db = db();
        // Our row was last observed at 500, so a peer that deleted at 400 saw
        // it before we revived it.
        let applied = apply_tombstone_if_newer(&db, "d1", 400).unwrap();

        assert!(!applied);
        let (state, hash) = content(&db);
        assert_eq!(
            state,
            Some(vec![1, 2]),
            "a losing tombstone must not take the content"
        );
        assert_eq!(hash, Some(vec![3, 4]));
    }

    #[test]
    fn a_newer_remote_tombstone_applies_and_clears_the_content() {
        let db = db();
        let applied = apply_tombstone_if_newer(&db, "d1", 600).unwrap();

        assert!(applied);
        assert_eq!(content(&db), (None, None));
    }

    #[test]
    fn applying_a_remote_tombstone_twice_is_idempotent() {
        let db = db();
        assert!(apply_tombstone_if_newer(&db, "d1", 600).unwrap());
        assert!(
            !apply_tombstone_if_newer(&db, "d1", 600).unwrap(),
            "the same stamp is not a later observation"
        );
    }

    #[test]
    fn a_tombstone_for_an_unknown_document_applies_to_nothing() {
        let db = db();
        assert!(!apply_tombstone_if_newer(&db, "never-heard-of-it", 600).unwrap());
    }
}
