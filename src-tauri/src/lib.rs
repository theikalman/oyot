use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

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

pub fn get_db_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join("oyot.db")
}

fn init_db_tables(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('journal', 'note')),
            title TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS document_links (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id),
            FOREIGN KEY (source_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (target_id) REFERENCES documents(id) ON DELETE CASCADE
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS todos (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            text TEXT NOT NULL,
            is_completed INTEGER NOT NULL CHECK(is_completed IN (0, 1)) DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_todos_document ON todos(document_id)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_links_target ON document_links(target_id)",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
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

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", timestamp)
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

fn format_journal_date(date_str: &str) -> Option<String> {
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

#[tauri::command]
fn init_database(workspace_path: String) -> Result<String, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    init_db_tables(&conn)?;
    Ok(db_path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_all_documents(workspace_path: String) -> Result<IndexData, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT id, type, title, content_json, created_at, updated_at FROM documents ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;

    let documents: Vec<Document> = stmt
        .query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                content_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = conn
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

    let mut stmt = conn
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
fn get_document(workspace_path: String, doc_id: String) -> Result<Document, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let doc = conn.query_row(
        "SELECT id, type, title, content_json, created_at, updated_at FROM documents WHERE id = ?",
        params![doc_id],
        |row| Ok(Document {
            id: row.get(0)?,
            doc_type: row.get(1)?,
            title: row.get(2)?,
            content_json: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        }),
    ).map_err(|e| e.to_string())?;

    Ok(doc)
}

#[tauri::command]
fn create_document(
    workspace_path: String,
    doc_type: String,
    title: String,
    content_json: String,
) -> Result<Document, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let doc_id = if doc_type == "journal" {
        format_journal_date(&title).unwrap_or_else(|| title.clone())
    } else {
        uuid_v4()
    };

    conn.execute(
        "INSERT INTO documents (id, type, title, content_json) VALUES (?, ?, ?, ?)",
        params![doc_id, doc_type, title, content_json],
    )
    .map_err(|e| e.to_string())?;

    update_document_links(&conn, &doc_id, &content_json)?;
    update_document_todos(&conn, &doc_id, &content_json)?;

    get_document(workspace_path, doc_id)
}

#[tauri::command]
fn update_document(
    workspace_path: String,
    doc_id: String,
    title: String,
    content_json: String,
) -> Result<Document, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE documents SET title = ?, content_json = ?, updated_at = datetime('now') WHERE id = ?",
        params![title, content_json, doc_id],
    ).map_err(|e| e.to_string())?;

    update_document_links(&conn, &doc_id, &content_json)?;
    update_document_todos(&conn, &doc_id, &content_json)?;

    get_document(workspace_path, doc_id)
}

#[tauri::command]
fn delete_document(workspace_path: String, doc_id: String) -> Result<(), String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM documents WHERE id = ?", params![doc_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn search_documents(workspace_path: String, query: String) -> Result<Vec<SearchResult>, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let search_pattern = format!("%{}%", query.to_lowercase());

    let mut stmt = conn.prepare(
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
fn get_backlinks(workspace_path: String, target_title: String) -> Result<Vec<Document>, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let target_id = find_document_by_title(&conn, &target_title);
    if target_id.is_none() {
        return Ok(Vec::new());
    }

    let target_id = target_id.unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.type, d.title, d.content_json, d.created_at, d.updated_at 
         FROM documents d
         JOIN document_links l ON d.id = l.source_id 
         WHERE l.target_id = ?",
        )
        .map_err(|e| e.to_string())?;

    let backlinks: Vec<Document> = stmt
        .query_map(params![target_id], |row| {
            Ok(Document {
                id: row.get(0)?,
                doc_type: row.get(1)?,
                title: row.get(2)?,
                content_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(backlinks)
}

#[tauri::command]
fn get_journals(workspace_path: String) -> Result<Vec<JournalEntry>, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
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
fn get_or_create_today_journal(workspace_path: String) -> Result<Document, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let today_title = get_today_date();

    let result: Option<Document> = conn.query_row(
        "SELECT id, type, title, content_json, created_at, updated_at FROM documents WHERE type = 'journal' AND title = ?",
        params![&today_title],
        |row| Ok(Document {
            id: row.get(0)?,
            doc_type: row.get(1)?,
            title: row.get(2)?,
            content_json: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    ).ok();

    if let Some(doc) = result {
        return Ok(doc);
    }

    let empty_content = r#"{"type":"doc","content":[]}"#;
    let doc_id = format_journal_date(&today_title).unwrap_or_else(|| today_title.clone());
    conn.execute(
        "INSERT INTO documents (id, type, title, content_json) VALUES (?, 'journal', ?, ?)",
        params![&doc_id, &today_title, empty_content],
    )
    .map_err(|e| e.to_string())?;

    get_document(workspace_path, doc_id)
}

fn get_today_date() -> String {
    let now = chrono::Local::now();
    now.format("%Y-%m-%d").to_string()
}

#[tauri::command]
fn get_todos(workspace_path: String) -> Result<Vec<Todo>, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
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

const MAX_RECENT_WORKSPACES: usize = 5;

fn read_config(app: &tauri::AppHandle) -> serde_json::Value {
    let config_path = match app.path().app_data_dir().ok() {
        Some(dir) => dir.join("config.json"),
        None => return serde_json::Value::Object(Default::default()),
    };
    let content = match std::fs::read_to_string(config_path).ok() {
        Some(c) => c,
        None => return serde_json::Value::Object(Default::default()),
    };
    serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
}

fn write_config(app: &tauri::AppHandle, json: serde_json::Value) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let config_path = app_data_dir.join("config.json");
    std::fs::write(config_path, json.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent_workspaces(app: tauri::AppHandle) -> Vec<String> {
    let json = read_config(&app);
    json.get("recent_workspaces")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn save_recent_workspace(app: tauri::AppHandle, workspace_path: String) -> Result<(), String> {
    let mut json = read_config(&app);

    // Read existing list, deduplicate, prepend new path, cap at MAX
    let mut recents: Vec<String> = json
        .get("recent_workspaces")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    recents.retain(|p| p != &workspace_path);
    recents.insert(0, workspace_path);
    recents.truncate(MAX_RECENT_WORKSPACES);

    json["recent_workspaces"] = serde_json::json!(recents);
    write_config(&app, json)
}

#[tauri::command]
fn get_theme(app: tauri::AppHandle) -> String {
    let json = read_config(&app);
    json.get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "light" || *s == "dark")
        .unwrap_or("light")
        .to_string()
}

#[tauri::command]
fn save_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    if theme != "light" && theme != "dark" {
        return Err(format!("Invalid theme: {}", theme));
    }
    let mut json = read_config(&app);
    json["theme"] = serde_json::json!(theme);
    write_config(&app, json)
}

#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workspace_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let workspace = app_data.join("Oyot");
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            init_database,
            get_all_documents,
            get_document,
            create_document,
            update_document,
            delete_document,
            search_documents,
            get_backlinks,
            get_journals,
            get_todos,
            get_or_create_today_journal,
            get_recent_workspaces,
            save_recent_workspace,
            get_theme,
            save_theme,
            get_app_data_dir,
            get_workspace_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
