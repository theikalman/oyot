use crate::db::AppState;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub crdt_state: Option<Vec<u8>>,
    pub content_hash: Option<Vec<u8>>,
    pub title_updated_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub lifecycle_updated_at: i64,
}

// Column list backing `row_to_document`; keep the two in lockstep.
const DOCUMENT_COLUMNS: &str = "id, type, title, created_at, updated_at, crdt_state, \
     content_hash, COALESCE(title_updated_at, updated_at), is_deleted, deleted_at, \
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
    let is_deleted_int: i64 = row.get(8)?;
    Ok(Document {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        crdt_state: row.get(5)?,
        content_hash: row.get(6)?,
        title_updated_at: row.get(7)?,
        is_deleted: is_deleted_int != 0,
        deleted_at: row.get(9)?,
        lifecycle_updated_at: row.get(10)?,
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
        db.execute(
            "INSERT OR IGNORE INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
            params![&doc_id, &title],
        )
        .map_err(|e| e.to_string())?;
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
        db.execute(
            "UPDATE document_index SET title = ? WHERE document_id = ?",
            params![&title, &doc_id],
        )
        .map_err(|e| e.to_string())?;
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
        // Last-writer-wins: a tombstone only applies if the peer observed the
        // delete later than whatever we last observed for this row. Otherwise a
        // stale tombstone would undo a revival that happened after it.
        db.execute(
            "UPDATE documents
                SET is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1
              WHERE id = ?2
                AND (lifecycle_updated_at IS NULL OR lifecycle_updated_at < ?1)",
            params![deleted_at, &doc_id],
        )
        .map_err(|e| e.to_string())?
    };

    // Only drop the CRDT history if the tombstone actually won. Doing it
    // unconditionally would empty a document whose revival we had already
    // accepted, while leaving the row live.
    if applied > 0 {
        state.snapshot.delete_document_data(&doc_id)?;
    }
    Ok(applied > 0)
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
        db.execute(
            "INSERT INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
            params![&doc_id, &title],
        )
        .map_err(|e| e.to_string())?;
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
        db.execute(
            "UPDATE document_index SET title = ? WHERE document_id = ?",
            params![&title, &doc_id],
        )
        .map_err(|e| e.to_string())?;
    }

    get_document(state, doc_id)
}

#[tauri::command]
pub fn delete_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let now = current_timestamp();
    let db = state.db.lock();
    db.execute(
        "UPDATE documents SET is_deleted = 1, deleted_at = ?1, lifecycle_updated_at = ?1 WHERE id = ?2",
        params![now, &doc_id],
    )
    .map_err(|e| e.to_string())?;

    drop(db);
    state.snapshot.delete_document_data(&doc_id)?;

    Ok(())
}

#[tauri::command]
pub fn search_documents(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.lock();
    let search_pattern = format!("%{}%", query.to_lowercase());

    let mut stmt = db
        .prepare(
            "SELECT d.id, d.title FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0 AND (LOWER(d.title) LIKE ?)",
        )
        .map_err(|e| e.to_string())?;

    let results: Vec<serde_json::Value> = stmt
        .query_map(params![&search_pattern], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            Ok(serde_json::json!({
                "id": id,
                "title": title,
                "line_content": ""
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn get_backlinks(
    state: tauri::State<'_, AppState>,
    _target_title: String,
) -> Result<Vec<DocumentSummary>, String> {
    let db = state.db.lock();
    let mut stmt = db.prepare(
        "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at,
                CASE WHEN EXISTS (SELECT 1 FROM yjs_updates u WHERE u.document_id = d.id)
                       OR EXISTS (SELECT 1 FROM yjs_snapshots s WHERE s.document_id = d.id)
                     THEN 1 ELSE 0 END as has_content
         FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0"
    )
    .map_err(|e| e.to_string())?;

    let backlinks: Vec<DocumentSummary> = stmt
        .query_map([], row_to_document_summary)
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

        db.execute(
            "INSERT OR IGNORE INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
            params![&doc_id, &today_title],
        )
        .map_err(|e| e.to_string())?;
    }

    get_document(state, doc_id)
}
