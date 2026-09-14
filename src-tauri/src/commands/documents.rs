use crate::db::AppState;
use crate::indexer;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
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

// An empty Yjs document still encodes to two bytes, so "has content" is a
// length test rather than a null test. Mirrors EMPTY_UPDATE_LEN on the
// frontend, which is the same constant the save path checks before writing.
const HAS_CONTENT: &str = "CASE WHEN length(d.crdt_state) > 2 THEN 1 ELSE 0 END";

fn query_all_documents(db: &rusqlite::Connection) -> Result<IndexData, String> {
    // No content filter. Requiring content to appear in the list meant a note
    // created with a title but never typed in vanished on the next launch:
    // still in the database, but unreachable, so it could not be opened,
    // renamed or deleted. `has_content` is reported so the calendar can mark
    // which days have an entry; it is not a reason to hide a row.
    let sql = format!(
        "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at,
                {HAS_CONTENT} as has_content
         FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0
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
    /// Only meaningful for a tombstone. Defaulted because `ensure_document`
    /// has no use for it and does not send it.
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

/// Record a peer's tombstone for a document we have never seen. Returns
/// whether a row was inserted.
///
/// `DO NOTHING` on conflict: a document we already know about is
/// `apply_tombstone_if_newer`'s business, and that has the last-writer-wins
/// check this deliberately does not need.
///
/// No search or index row is written. A tombstone is not a document the user
/// can find; it exists only to be carried in the manifest.
pub fn insert_tombstone(db: &Connection, entry: &EnsureDocumentRequest) -> Result<bool, String> {
    let title_updated_at = entry.title_updated_at.unwrap_or(entry.updated_at);
    let lifecycle_updated_at = entry.lifecycle_updated_at.unwrap_or(entry.created_at);
    let deleted_at = entry.deleted_at.unwrap_or(lifecycle_updated_at);
    let inserted = db
        .execute(
            "INSERT INTO documents
                 (id, type, title, created_at, updated_at, title_updated_at,
                  is_deleted, deleted_at, lifecycle_updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)
             ON CONFLICT(id) DO NOTHING",
            params![
                &entry.doc_id,
                &entry.doc_type,
                &entry.title,
                entry.created_at,
                entry.updated_at,
                title_updated_at,
                deleted_at,
                lifecycle_updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// Materialise a peer's tombstone for a document this device has never held.
///
/// Dropping it, which is what used to happen, is what stopped a delete
/// propagating past the first device that never had the document: nothing to
/// mark, so nothing to advertise onward, and a third device that still holds
/// the document hands it straight back on the next exchange. With three
/// devices the deletion flaps until all of them have met since it happened,
/// and if the deleting device is lost it never settles at all.
#[tauri::command]
pub fn ensure_tombstone(
    state: tauri::State<'_, AppState>,
    entry: EnsureDocumentRequest,
) -> Result<(), String> {
    let db = state.db.lock();
    insert_tombstone(&db, &entry)?;
    Ok(())
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
        // A live document has no delete stamp; `ensure_tombstone` owns that.
        deleted_at: _,
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
// propagating), dropping the content with it. Idempotent. Returns true if the
// local row changed, i.e. the peer's tombstone was the later observation. A
// losing tombstone leaves the document, and its content, alone.
#[tauri::command]
pub fn apply_remote_delete(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    deleted_at: i64,
) -> Result<bool, String> {
    let db = state.db.lock();
    apply_tombstone_if_newer(&db, &doc_id, deleted_at)
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
    Ok(now)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchHit {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    /// A fragment of the body around the match, with the matched terms
    /// wrapped in the control characters the frontend splits on. Empty when
    /// the match was in the title only.
    pub snippet: String,
}

/// Full-text search over titles and bodies.
///
/// Previously a `LIKE '%q%'` over titles alone, which could not find anything
/// the user had actually written. Bodies are indexed at save time (see
/// `indexer`), because document content lives in the CRDT and is not otherwise
/// queryable.
pub fn run_search(db: &Connection, query: &str) -> Result<Vec<SearchHit>, String> {
    let Some(match_query) = indexer::to_fts_query(query) else {
        return Ok(Vec::new());
    };

    // The match markers are ASCII start-of-text and end-of-text. A note cannot
    // contain them by any ordinary means, so they cannot be confused with the
    // text itself, and the frontend splits on them to render the highlight as
    // an element. The previous `[` and `]` were rendered verbatim, so every
    // result showed literal brackets and no highlight.
    // Kept in step with src/lib/search/snippet.ts.
    let mut stmt = db
        .prepare(
            "SELECT d.id, d.type, d.title,
                    snippet(document_search, 2, char(2), char(3), '…', 12) AS snippet
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

#[tauri::command]
pub fn search_documents(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let db = state.db.lock();
    run_search(&db, &query)
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
                    {HAS_CONTENT} as has_content
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

/// Today's journal, and whether opening it was news.
#[derive(Debug, Serialize)]
pub struct TodayJournal {
    pub document: Document,
    /// True when this call created the row or revived a tombstone. False when
    /// today's entry was simply already there, which is every launch after the
    /// first one of the day.
    pub created: bool,
}

/// Create today's journal, or revive it if it was deleted. Returns whether
/// anything changed, i.e. whether peers have something to be told.
///
/// One upsert rather than SELECT-then-INSERT for the write itself: the old
/// form released the mutex between the two, and failed outright once the
/// day's journal had been deleted, because the tombstone still owned the id.
/// Failing here took the whole app down with it, since startup awaits this
/// before it can show a document.
pub fn upsert_today_journal(
    db: &Connection,
    doc_id: &str,
    title: &str,
    now: i64,
) -> Result<bool, String> {
    // Asked under the same lock as the write, because the upsert cannot tell
    // us: SQLite reports one row changed whether it inserted or updated. A row
    // that is already live is one every peer has heard about.
    let already_live = db
        .query_row(
            "SELECT 1 FROM documents WHERE id = ? AND is_deleted = 0",
            params![doc_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();

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
        params![doc_id, title, now],
    )
    .map_err(|e| e.to_string())?;

    indexer::update_document_title(db, doc_id, title)?;
    Ok(!already_live)
}

#[tauri::command]
pub fn get_or_create_today_journal(
    state: tauri::State<'_, AppState>,
) -> Result<TodayJournal, String> {
    let today_title = get_today_date();
    let doc_id = format_journal_date(&today_title).unwrap_or_else(|| today_title.clone());
    let now = current_timestamp();

    let created = {
        let db = state.db.lock();
        upsert_today_journal(&db, &doc_id, &today_title, now)?
    };

    Ok(TodayJournal {
        document: get_document(state, doc_id)?,
        created,
    })
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

    // The regression: the list required a row in the update log, and only a
    // save with content wrote one. A note created with a title but never
    // typed in vanished on the next launch. It was still in the database and
    // still synced, but there was no way to open, rename or delete it.
    #[test]
    fn a_document_with_no_content_still_appears_in_the_list() {
        let db = db();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('empty', 'note', 'Untouched', 2, 2)",
            [],
        )
        .unwrap();

        let listed = query_all_documents(&db).unwrap();
        let ids: Vec<&str> = listed.documents.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"empty"), "got {ids:?}");
    }

    #[test]
    fn has_content_reflects_the_column_the_content_lives_in() {
        let db = db();
        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('null', 'note', 'No state', 2, 2);
             -- An empty Yjs document encodes to two bytes, never zero, so a
             -- null test alone would report it as having content.
             INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
                 VALUES ('bare', 'note', 'Empty state', x'0000', 2, 2);
             INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
                 VALUES ('full', 'note', 'Written in', x'00010203', 2, 2);",
        )
        .unwrap();

        let listed = query_all_documents(&db).unwrap();
        let has = |id: &str| {
            listed
                .documents
                .iter()
                .find(|d| d.id == id)
                .unwrap()
                .has_content
        };
        assert!(has("full"), "a written-in document has content");
        assert!(!has("null"), "no state at all");
        assert!(!has("bare"), "the bare empty update is not content");
    }

    #[test]
    fn a_deleted_document_stays_out_of_the_list() {
        let db = db();
        tombstone_document(&db, "d1", 900).unwrap();
        assert!(query_all_documents(&db).unwrap().documents.is_empty());
    }

    // `char(2)` and `char(3)` have to be something SQLite's snippet() accepts
    // as markers, and the result has to come back with them in place, or the
    // frontend has nothing to split on and shows an unhighlighted fragment.
    #[test]
    fn a_search_hit_marks_the_matched_text() {
        let db = db();
        crate::indexer::update_document_index(
            &db,
            "d1",
            "One",
            &crate::indexer::DocumentIndexInput {
                text: "the quarterly meeting notes".into(),
                link_targets: vec![],
                todo_count: 0,
                completed_todo_count: 0,
            },
        )
        .unwrap();

        let hits = run_search(&db, "meeting").unwrap();

        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].snippet.contains('\u{2}') && hits[0].snippet.contains('\u{3}'),
            "expected marked text, got {:?}",
            hits[0].snippet
        );
        // The markers wrap the matched word and nothing else.
        let marked: String = hits[0]
            .snippet
            .split('\u{2}')
            .nth(1)
            .and_then(|rest| rest.split('\u{3}').next())
            .unwrap_or_default()
            .to_string();
        assert_eq!(marked, "meeting");
    }

    #[test]
    fn a_search_for_nothing_returns_nothing() {
        let db = db();
        assert!(run_search(&db, "   ").unwrap().is_empty());
    }

    #[test]
    fn a_deleted_document_is_not_a_search_hit() {
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
        assert_eq!(run_search(&db, "findable").unwrap().len(), 1);

        tombstone_document(&db, "d1", 900).unwrap();
        assert!(run_search(&db, "findable").unwrap().is_empty());
    }

    fn tombstone_entry(id: &str) -> EnsureDocumentRequest {
        EnsureDocumentRequest {
            doc_id: id.to_string(),
            doc_type: "note".to_string(),
            title: "Gone".to_string(),
            created_at: 10,
            updated_at: 20,
            title_updated_at: Some(20),
            lifecycle_updated_at: Some(700),
            deleted_at: Some(700),
        }
    }

    // This is what lets a delete reach a device that never held the document,
    // and through it to a third device that still does.
    #[test]
    fn a_peers_tombstone_is_recorded_for_an_unknown_document() {
        let db = db();
        assert!(insert_tombstone(&db, &tombstone_entry("d2")).unwrap());

        let (deleted, stamp): (i64, i64) = db
            .query_row(
                "SELECT is_deleted, lifecycle_updated_at FROM documents WHERE id = 'd2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(
            stamp, 700,
            "the stamp has to survive or LWW cannot order it"
        );
    }

    #[test]
    fn a_recorded_tombstone_is_not_searchable() {
        let db = db();
        insert_tombstone(&db, &tombstone_entry("d2")).unwrap();
        let rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM document_search WHERE document_id = 'd2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    // Announcing today's journal on every launch made each peer pull the
    // whole document back, because `onLiveCreated` answers a `doc-created`
    // for a document it has with a `sync-need` carrying an empty state
    // vector. Only an actual change is news.
    #[test]
    fn opening_todays_journal_is_news_only_the_first_time() {
        let db = db();
        assert!(
            upsert_today_journal(&db, "14 Sep 2026", "2026-09-14", 100).unwrap(),
            "the first open creates it"
        );
        assert!(
            !upsert_today_journal(&db, "14 Sep 2026", "2026-09-14", 200).unwrap(),
            "every later open is not"
        );
    }

    #[test]
    fn reviving_a_deleted_journal_is_news_again() {
        let db = db();
        upsert_today_journal(&db, "14 Sep 2026", "2026-09-14", 100).unwrap();
        tombstone_document(&db, "14 Sep 2026", 200).unwrap();

        assert!(
            upsert_today_journal(&db, "14 Sep 2026", "2026-09-14", 300).unwrap(),
            "a revival is exactly what peers need to hear about"
        );

        let (deleted, stamp): (i64, i64) = db
            .query_row(
                "SELECT is_deleted, lifecycle_updated_at FROM documents WHERE id = '14 Sep 2026'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(stamp, 300, "the revival must outrank the delete");
    }

    // A row we already have belongs to the last-writer-wins path, which this
    // one has no stamp comparison to do correctly.
    #[test]
    fn recording_a_tombstone_never_touches_a_document_we_have() {
        let db = db();
        let mut entry = tombstone_entry("d1");
        entry.title = "Should not appear".to_string();

        assert!(!insert_tombstone(&db, &entry).unwrap());

        let (title, deleted): (String, i64) = db
            .query_row(
                "SELECT title, is_deleted FROM documents WHERE id = 'd1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "One");
        assert_eq!(deleted, 0);
    }
}
