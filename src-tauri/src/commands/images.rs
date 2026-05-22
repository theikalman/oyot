use crate::db::AppState;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn uuid_v4() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", timestamp)
}

#[tauri::command]
pub fn save_image(
    state: tauri::State<'_, AppState>,
    image_data: String,
    mime_type: String,
) -> Result<String, String> {
    use base64::Engine;
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_data)
        .map_err(|e| e.to_string())?;

    let mut hasher = Sha256::new();
    hasher.update(&image_bytes);
    let hash = hex::encode(hasher.finalize());

    let ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    };
    let filename = format!("{}.{}", hash, ext);

    let attachments_dir = PathBuf::from(&state.workspace_path).join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let full_path = attachments_dir.join(&filename);
    std::fs::write(&full_path, &image_bytes).map_err(|e| e.to_string())?;

    let now = current_timestamp();
    let relative_path = format!("attachments/{}", filename);

    let db = state.db.lock();
    db.execute(
        "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
        params![&hash, &mime_type, &relative_path, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(hash)
}

#[tauri::command]
pub fn delete_image(state: tauri::State<'_, AppState>, hash: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE attachments SET local_path = NULL, is_fully_downloaded = 0 WHERE hash = ?",
        params![&hash],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn cleanup_orphaned_images(state: tauri::State<'_, AppState>) -> Result<i32, String> {
    let orphaned: Vec<String> = {
        let db = state.db.lock();
        let mut stmt = db
            .prepare("SELECT local_path FROM attachments WHERE is_fully_downloaded = 0 AND local_path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    let count = orphaned.len() as i32;
    for path in &orphaned {
        let full_path = PathBuf::from(&state.workspace_path).join(path);
        if full_path.exists() {
            let _ = std::fs::remove_file(&full_path);
        }
    }

    let db = state.db.lock();
    db.execute(
        "UPDATE attachments SET local_path = NULL, is_fully_downloaded = 0 WHERE is_fully_downloaded = 0",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(count)
}

#[tauri::command]
pub fn get_attachment_path(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock();
    let result: Option<String> = db
        .query_row(
            "SELECT local_path FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
            params![&hash],
            |row| row.get(0),
        )
        .ok();
    Ok(result)
}

#[tauri::command]
pub fn request_attachment(state: tauri::State<'_, AppState>, hash: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE attachments SET is_fully_downloaded = 0 WHERE hash = ?",
        params![&hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
