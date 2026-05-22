use crate::db::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub crdt_state: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DocumentSummary {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub todo_count: i32,
    pub completed_todo_count: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexData {
    pub documents: Vec<DocumentSummary>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalEntry {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub crdt_state: Vec<u8>,
    pub created_at: i64,
}

pub fn uuid_v4() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", timestamp)
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
    Ok(DocumentSummary {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        todo_count: row.get(3)?,
        completed_todo_count: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn row_to_document(row: &rusqlite::Row) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        crdt_state: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tauri::command]
pub fn get_all_documents(state: tauri::State<'_, AppState>) -> Result<IndexData, String> {
    let db = state.db.lock();
    let mut stmt = db.prepare(
        "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at
         FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0
         ORDER BY d.created_at DESC"
    ).map_err(|e| e.to_string())?;

    let documents: Vec<DocumentSummary> = stmt
        .query_map([], row_to_document_summary)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(IndexData { documents })
}

#[tauri::command]
pub fn get_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<Document, String> {
    let db = state.db.lock();
    db.query_row(
        "SELECT id, type, title, crdt_state, created_at, updated_at FROM documents WHERE id = ? AND is_deleted = 0",
        params![doc_id],
        row_to_document,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_document(
    state: tauri::State<'_, AppState>,
    doc_type: String,
    title: String,
    crdt_state: Vec<u8>,
) -> Result<Document, String> {
    let doc_id = if doc_type == "journal" {
        format_journal_date(&title).unwrap_or_else(|| title.clone())
    } else {
        uuid_v4()
    };
    let now = current_timestamp();

    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![&doc_id, &doc_type, &title, &crdt_state, now, now],
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
    crdt_state: Vec<u8>,
) -> Result<Document, String> {
    let now = current_timestamp();
    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET title = ?, crdt_state = ?, updated_at = ? WHERE id = ? AND is_deleted = 0",
            params![&title, &crdt_state, now, &doc_id],
        ).map_err(|e| e.to_string())?;
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
    let db = state.db.lock();
    db.execute(
        "UPDATE documents SET is_deleted = 1 WHERE id = ?",
        params![&doc_id],
    )
    .map_err(|e| e.to_string())?;

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
            "SELECT d.id, d.title, d.crdt_state FROM documents d
         LEFT JOIN document_index i ON d.id = i.document_id
         WHERE d.is_deleted = 0 AND (LOWER(d.title) LIKE ?)",
        )
        .map_err(|e| e.to_string())?;

    let results: Vec<serde_json::Value> = stmt
        .query_map(params![&search_pattern], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let crdt_state: Vec<u8> = row.get(2)?;
            let content_preview = String::from_utf8_lossy(&crdt_state).to_string();
            Ok(serde_json::json!({
                "id": id,
                "title": title,
                "line_content": content_preview
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
        "SELECT d.id, d.type, d.title, COALESCE(i.todo_count, 0), COALESCE(i.completed_todo_count, 0), d.created_at, d.updated_at
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
pub fn get_journals(state: tauri::State<'_, AppState>) -> Result<Vec<JournalEntry>, String> {
    let db = state.db.lock();
    let mut stmt = db.prepare(
        "SELECT id, type, title, crdt_state, created_at FROM documents WHERE type = 'journal' AND is_deleted = 0 ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;

    let journals: Vec<JournalEntry> = stmt
        .query_map([], |row| {
            Ok(JournalEntry {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                crdt_state: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(journals)
}

#[tauri::command]
pub fn get_or_create_today_journal(state: tauri::State<'_, AppState>) -> Result<Document, String> {
    let today_title = get_today_date();
    let doc_id = format_journal_date(&today_title).unwrap_or_else(|| today_title.clone());

    let existing = {
        let db = state.db.lock();
        db.query_row(
            "SELECT id, type, title, crdt_state, created_at, updated_at FROM documents WHERE type = 'journal' AND title = ? AND is_deleted = 0",
            params![&today_title],
            row_to_document,
        ).ok()
    };

    if let Some(doc) = existing {
        return Ok(doc);
    }

    let empty_content = br#"{"type":"doc","content":[]}"#;
    let now = current_timestamp();
    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at) VALUES (?, 'journal', ?, ?, ?, ?)",
            params![&doc_id, &today_title, empty_content.to_vec(), now, now],
        )
        .map_err(|e| e.to_string())?;
    }

    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
            params![&doc_id, &today_title],
        )
        .map_err(|e| e.to_string())?;
    }

    get_document(state, doc_id)
}
