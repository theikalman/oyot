use crate::db::AppState;
use rusqlite::params;
use std::path::PathBuf;

#[tauri::command]
pub fn save_image(
    state: tauri::State<'_, AppState>,
    image_data: String,
    filename: String,
) -> Result<String, String> {
    let images_dir = PathBuf::from(&state.workspace_path).join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let uuid = uuid_v4();
    let sanitized = sanitize_filename(&filename);
    let final_filename = format!("{}-{}", uuid, sanitized);

    use base64::Engine;
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_data)
        .map_err(|e| e.to_string())?;

    let full_path = images_dir.join(&final_filename);
    std::fs::write(&full_path, &image_bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("images/{}", final_filename);

    let db = state.db.lock();
    db.execute(
        "INSERT INTO images (path, ref_count) VALUES (?, 1)
         ON CONFLICT(path) DO UPDATE SET ref_count = ref_count + 1",
        params![&relative_path],
    )
    .map_err(|e| e.to_string())?;

    Ok(relative_path)
}

#[tauri::command]
pub fn delete_image(state: tauri::State<'_, AppState>, image_path: String) -> Result<(), String> {
    let full_path = PathBuf::from(&state.workspace_path).join(&image_path);
    if full_path.exists() {
        std::fs::remove_file(&full_path).map_err(|e| e.to_string())?;
    }

    let db = state.db.lock();
    db.execute(
        "UPDATE images SET ref_count = ref_count - 1 WHERE path = ?",
        params![&image_path],
    )
    .map_err(|e| e.to_string())?;

    db.execute("DELETE FROM images WHERE ref_count <= 0", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn cleanup_orphaned_images(state: tauri::State<'_, AppState>) -> Result<i32, String> {
    let orphaned: Vec<String> = {
        let db = state.db.lock();
        let mut stmt = db
            .prepare("SELECT path FROM images WHERE ref_count <= 0")
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
    db.execute("DELETE FROM images WHERE ref_count <= 0", [])
        .map_err(|e| e.to_string())?;

    Ok(count)
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", timestamp)
}

fn sanitize_filename(filename: &str) -> String {
    let parts: Vec<&str> = filename.rsplitn(2, '.').collect();
    if parts.len() == 2 {
        let name = parts[1];
        let ext = parts[0];
        let sanitized_name = name
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
            .collect::<String>();
        format!("{}.{}", sanitized_name, ext)
    } else {
        filename
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
            .collect()
    }
}
