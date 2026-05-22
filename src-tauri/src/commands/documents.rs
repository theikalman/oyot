use crate::db::{get_db_path, AppState};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub content_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DocumentLink {
    pub source_id: String,
    pub target_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: String,
    pub document_id: String,
    pub text: String,
    pub is_completed: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub line_number: i32,
    pub line_content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexData {
    pub documents: Vec<Document>,
    pub links: Vec<DocumentLink>,
    pub all_links: Vec<String>,
    pub todos: Vec<Todo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JournalEntry {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub content_json: String,
    pub created_at: String,
}

pub fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
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

fn extract_wikilinks(content_json: &str) -> Vec<String> {
    let re = Regex::new(r"\[\[(.+?)\]\]").unwrap();
    re.captures_iter(content_json)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn extract_todos_from_content(content_json: &str) -> Vec<(String, String, bool)> {
    let mut todos = Vec::new();
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content_json) {
        extract_todos_from_json(&parsed, &mut todos);
    }
    todos
}

fn extract_todos_from_json(node: &serde_json::Value, todos: &mut Vec<(String, String, bool)>) {
    if let Some(node_type) = node.get("type").and_then(|v| v.as_str()) {
        if node_type == "taskItem" {
            let id = node
                .get("attrs")
                .and_then(|a| a.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid_v4());

            let text = node
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|n| n.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();

            let completed = node
                .get("attrs")
                .and_then(|a| a.get("checked"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            todos.push((id, text, completed));
        }
    }

    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        for child in content {
            extract_todos_from_json(child, todos);
        }
    }
}

fn update_document_links(
    conn: &Connection,
    doc_id: &str,
    content_json: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM document_links WHERE source_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;

    let links = extract_wikilinks(content_json);
    for link in links {
        let target_id = find_document_by_title(conn, &link);
        if let Some(tid) = target_id {
            conn.execute(
                "INSERT INTO document_links (source_id, target_id) VALUES (?, ?)",
                params![doc_id, tid],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn find_document_by_title(conn: &Connection, title: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM documents WHERE LOWER(title) = LOWER(?)",
        params![title],
        |row| row.get(0),
    )
    .ok()
}

fn update_document_todos(
    conn: &Connection,
    doc_id: &str,
    content_json: &str,
) -> Result<(), String> {
    conn.execute("DELETE FROM todos WHERE document_id = ?", params![doc_id])
        .map_err(|e| e.to_string())?;

    let todos = extract_todos_from_content(content_json);
    for (id, text, completed) in todos {
        conn.execute(
            "INSERT INTO todos (id, document_id, text, is_completed) VALUES (?, ?, ?, ?)",
            params![id, doc_id, text, completed as i32],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn row_to_document(row: &rusqlite::Row) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        doc_type: row.get(1)?,
        title: row.get(2)?,
        content_json: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[tauri::command]
pub fn get_all_documents(state: tauri::State<'_, AppState>) -> Result<IndexData, String> {
    let db = state.db.lock();
    let mut stmt = db.prepare(
        "SELECT id, type, title, content_json, created_at, updated_at FROM documents ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;

    let documents: Vec<Document> = stmt
        .query_map([], row_to_document)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = db
        .prepare("SELECT source_id, target_id FROM document_links")
        .map_err(|e| e.to_string())?;

    let links: Vec<DocumentLink> = stmt
        .query_map([], |row| {
            Ok(DocumentLink {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = db
        .prepare(
            "SELECT id, document_id, text, is_completed, created_at FROM todos ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;

    let todos: Vec<Todo> = stmt
        .query_map([], |row| {
            let is_completed: i32 = row.get(3)?;
            Ok(Todo {
                id: row.get(0)?,
                document_id: row.get(1)?,
                text: row.get(2)?,
                is_completed: is_completed != 0,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let all_links: Vec<String> = documents
        .iter()
        .filter(|d| d.doc_type == "note")
        .map(|d| d.title.clone())
        .collect();

    Ok(IndexData {
        documents,
        links,
        all_links,
        todos,
    })
}

#[tauri::command]
pub fn get_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<Document, String> {
    let db = state.db.lock();
    db.query_row(
        "SELECT id, type, title, content_json, created_at, updated_at FROM documents WHERE id = ?",
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
    content_json: String,
) -> Result<Document, String> {
    let doc_id = if doc_type == "journal" {
        format_journal_date(&title).unwrap_or_else(|| title.clone())
    } else {
        uuid_v4()
    };

    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents (id, type, title, content_json) VALUES (?, ?, ?, ?)",
            params![&doc_id, &doc_type, &title, &content_json],
        )
        .map_err(|e| e.to_string())?;
    }

    {
        let db = state.db.lock();
        update_document_links(&db, &doc_id, &content_json)?;
        update_document_todos(&db, &doc_id, &content_json)?;
    }

    get_document(state, doc_id)
}

#[tauri::command]
pub fn update_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    title: String,
    content_json: String,
) -> Result<Document, String> {
    {
        let db = state.db.lock();
        db.execute(
            "UPDATE documents SET title = ?, content_json = ?, updated_at = datetime('now') WHERE id = ?",
            params![&title, &content_json, &doc_id],
        ).map_err(|e| e.to_string())?;
    }

    {
        let db = state.db.lock();
        update_document_links(&db, &doc_id, &content_json)?;
        update_document_todos(&db, &doc_id, &content_json)?;
    }

    get_document(state, doc_id)
}

#[tauri::command]
pub fn delete_document(state: tauri::State<'_, AppState>, doc_id: String) -> Result<(), String> {
    let content_json: Option<String> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT content_json FROM documents WHERE id = ?",
            params![&doc_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    if let Some(content) = content_json {
        let image_paths = get_image_paths_from_content(&content);
        decrement_image_ref_counts(&state.workspace_path, &image_paths)?;
    }

    let db = state.db.lock();
    db.execute("DELETE FROM documents WHERE id = ?", params![&doc_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn search_documents(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let db = state.db.lock();
    let search_pattern = format!("%{}%", query.to_lowercase());

    let mut stmt = db.prepare(
        "SELECT id, title, content_json FROM documents WHERE LOWER(title) LIKE ? OR LOWER(content_json) LIKE ?"
    ).map_err(|e| e.to_string())?;

    let docs: Vec<(String, String, String)> = stmt
        .query_map(params![&search_pattern, &search_pattern], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let query_lower = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();

    for (id, title, content) in docs {
        for (line_num, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&query_lower) {
                results.push(SearchResult {
                    id: id.clone(),
                    title: title.clone(),
                    line_number: (line_num + 1) as i32,
                    line_content: line.to_string(),
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn get_backlinks(
    state: tauri::State<'_, AppState>,
    target_title: String,
) -> Result<Vec<Document>, String> {
    let db = state.db.lock();

    let target_id = find_document_by_title(&db, &target_title);
    if target_id.is_none() {
        return Ok(Vec::new());
    }
    let target_id = target_id.unwrap();

    let mut stmt = db
        .prepare(
            "SELECT d.id, d.type, d.title, d.content_json, d.created_at, d.updated_at
         FROM documents d
         JOIN document_links l ON d.id = l.source_id
         WHERE l.target_id = ?",
        )
        .map_err(|e| e.to_string())?;

    let backlinks: Vec<Document> = stmt
        .query_map(params![&target_id], row_to_document)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(backlinks)
}

#[tauri::command]
pub fn get_journals(state: tauri::State<'_, AppState>) -> Result<Vec<JournalEntry>, String> {
    let db = state.db.lock();
    let mut stmt = db.prepare(
        "SELECT id, type, title, content_json, created_at FROM documents WHERE type = 'journal' ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;

    let journals: Vec<JournalEntry> = stmt
        .query_map([], |row| {
            Ok(JournalEntry {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                content_json: row.get(3)?,
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
            "SELECT id, type, title, content_json, created_at, updated_at FROM documents WHERE type = 'journal' AND title = ?",
            params![&today_title],
            row_to_document,
        ).ok()
    };

    if let Some(doc) = existing {
        return Ok(doc);
    }

    let empty_content = r#"{"type":"doc","content":[]}"#;
    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO documents (id, type, title, content_json) VALUES (?, 'journal', ?, ?)",
            params![&doc_id, &today_title, empty_content],
        )
        .map_err(|e| e.to_string())?;
    }

    get_document(state, doc_id)
}

#[tauri::command]
pub fn get_todos(state: tauri::State<'_, AppState>) -> Result<Vec<Todo>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT id, document_id, text, is_completed, created_at FROM todos ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;

    let todos: Vec<Todo> = stmt
        .query_map([], |row| {
            let is_completed: i32 = row.get(3)?;
            Ok(Todo {
                id: row.get(0)?,
                document_id: row.get(1)?,
                text: row.get(2)?,
                is_completed: is_completed != 0,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(todos)
}

pub fn get_image_paths_from_content(content_json: &str) -> Vec<String> {
    let re = Regex::new(r#"src="(asset://([^"]+))""#).unwrap();
    re.captures_iter(content_json)
        .filter_map(|cap| cap.get(2).map(|m| m.as_str().to_string()))
        .collect()
}

pub fn decrement_image_ref_counts(workspace_path: &str, paths: &[String]) -> Result<(), String> {
    let db_path = get_db_path(workspace_path);
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    for path in paths {
        conn.execute(
            "UPDATE images SET ref_count = ref_count - 1 WHERE path = ?",
            params![path],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute("DELETE FROM images WHERE ref_count <= 0", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}
