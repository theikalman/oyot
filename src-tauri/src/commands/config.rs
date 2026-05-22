use crate::db::{get_db_path, AppState};
use tauri::Manager;

const MAX_RECENT_WORKSPACES: usize = 5;

fn init_db_tables(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('journal', 'note')),
            title TEXT NOT NULL,
            crdt_state BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_deleted INTEGER DEFAULT 0 NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS document_index (
            document_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            todo_count INTEGER DEFAULT 0 NOT NULL,
            completed_todo_count INTEGER DEFAULT 0 NOT NULL,
            FOREIGN KEY (document_id) REFERENCES documents(id)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            mime_type TEXT NOT NULL,
            local_path TEXT,
            is_fully_downloaded INTEGER DEFAULT 0 NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_peers (
            node_id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            last_synchronized INTEGER
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_documents_is_deleted ON documents(is_deleted)",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn init_database(app: tauri::AppHandle, workspace_path: String) -> Result<String, String> {
    let db_path = get_db_path(&workspace_path);
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    init_db_tables(&conn)?;

    let state = AppState::new(workspace_path.clone())?;
    app.manage(state);

    Ok(db_path.to_string_lossy().to_string())
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

fn write_config(app: &tauri::AppHandle, json: serde_json::Value) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let config_path = app_data_dir.join("config.json");
    std::fs::write(config_path, json.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_workspaces(app: tauri::AppHandle) -> Vec<String> {
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
pub fn save_recent_workspace(app: tauri::AppHandle, workspace_path: String) -> Result<(), String> {
    let mut json = read_config(&app);

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
pub fn set_current_workspace(app: tauri::AppHandle, workspace_path: String) -> Result<(), String> {
    let mut json = read_config(&app);
    json["current_workspace"] = serde_json::json!(workspace_path);
    write_config(&app, json)
}

#[tauri::command]
pub fn get_theme(app: tauri::AppHandle) -> String {
    let json = read_config(&app);
    json.get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "light" || *s == "dark")
        .unwrap_or("light")
        .to_string()
}

#[tauri::command]
pub fn save_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    if theme != "light" && theme != "dark" {
        return Err(format!("Invalid theme: {}", theme));
    }
    let mut json = read_config(&app);
    json["theme"] = serde_json::json!(theme);
    write_config(&app, json)
}

#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_workspace_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let workspace = app_data.join("Oyot");
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    Ok(workspace.to_string_lossy().to_string())
}
