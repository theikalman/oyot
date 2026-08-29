use crate::db::AppState;
use rusqlite::params;
use sha2::{Digest, Sha256};
use tauri::Emitter;

fn ext_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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

    let hash = sha256_hex(&image_bytes);

    let ext = ext_for_mime(&mime_type);
    let filename = format!("{}.{}", hash, ext);

    let attachments_dir = state.data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

    let full_path = attachments_dir.join(&filename);
    std::fs::write(&full_path, &image_bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("attachments/{}", filename);
    let now = current_timestamp();

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
    let local_path: Option<String> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT local_path FROM attachments WHERE hash = ?",
            params![&hash],
            |row| row.get(0),
        )
        .ok()
    };

    if let Some(relative_path) = local_path {
        let full_path = state.data_dir.join(relative_path);
        if full_path.exists() {
            std::fs::remove_file(&full_path).map_err(|e| e.to_string())?;
        }
    }

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
        let full_path = state.data_dir.join(path);
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
pub fn request_attachment(state: tauri::State<'_, AppState>, hash: String) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "UPDATE attachments SET is_fully_downloaded = 0 WHERE hash = ?",
        params![&hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_attachment_info(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<AttachmentInfoResponse>, String> {
    let db = state.db.lock();
    let result = db.query_row(
        "SELECT hash, mime_type, local_path, is_fully_downloaded FROM attachments WHERE hash = ?",
        params![&hash],
        |row| {
            let local_path: Option<String> = row.get(2)?;
            let is_downloaded: i32 = row.get(3)?;
            Ok(AttachmentInfoResponse {
                hash: row.get(0)?,
                mime_type: row.get(1)?,
                local_path,
                is_fully_downloaded: is_downloaded == 1,
            })
        },
    );

    match result {
        Ok(info) => Ok(Some(info)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct AttachmentInfoResponse {
    pub hash: String,
    pub mime_type: String,
    pub local_path: Option<String>,
    pub is_fully_downloaded: bool,
}

#[tauri::command]
pub fn list_pending_attachments(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AttachmentInfoResponse>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT hash, mime_type, local_path, is_fully_downloaded FROM attachments WHERE is_fully_downloaded = 0")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let local_path: Option<String> = row.get(2)?;
            let is_downloaded: i32 = row.get(3)?;
            Ok(AttachmentInfoResponse {
                hash: row.get(0)?,
                mime_type: row.get(1)?,
                local_path,
                is_fully_downloaded: is_downloaded == 1,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok(info) = row {
            result.push(info);
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn get_local_blob_url(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock();
    let result = db.query_row(
        "SELECT local_path FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
        params![&hash],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(relative_path) => {
            let full_path = state.data_dir.join(relative_path);
            Ok(Some(full_path.to_string_lossy().to_string()))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn get_all_attachment_hashes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AttachmentHashInfo>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT hash, mime_type, is_fully_downloaded FROM attachments")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let is_downloaded: i32 = row.get(2)?;
            Ok(AttachmentHashInfo {
                hash: row.get(0)?,
                mime_type: row.get(1)?,
                is_fully_downloaded: is_downloaded == 1,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        if let Ok(info) = row {
            result.push(info);
        }
    }

    Ok(result)
}

#[derive(serde::Serialize)]
pub struct AttachmentHashInfo {
    pub hash: String,
    pub mime_type: String,
    pub is_fully_downloaded: bool,
}

// --- peer-to-peer attachment transfer -------------------------------------

#[derive(serde::Serialize)]
pub struct AttachmentManifestEntry {
    pub hash: String,
    pub mime_type: String,
    pub size: i64,
}

// Every attachment this device holds in full - advertised to a peer on connect
// so it can pull the ones it is missing. Mirrors the document `sync-manifest`.
#[tauri::command]
pub fn list_attachment_manifest(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AttachmentManifestEntry>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT hash, mime_type, local_path FROM attachments \
             WHERE is_fully_downloaded = 1 AND local_path IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (hash, mime_type, local_path) = row;
        let size = state
            .data_dir
            .join(&local_path)
            .metadata()
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        if size == 0 {
            continue; // file vanished under us - do not advertise it
        }
        out.push(AttachmentManifestEntry { hash, mime_type, size });
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct AttachmentBytesResponse {
    pub hash: String,
    pub mime_type: String,
    pub data: String, // base64
}

// Read one attachment's bytes to answer a peer's `attach-need`.
#[tauri::command]
pub fn get_attachment_bytes(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<AttachmentBytesResponse>, String> {
    use base64::Engine;

    let row: Option<(String, String)> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT mime_type, local_path FROM attachments \
             WHERE hash = ? AND is_fully_downloaded = 1 AND local_path IS NOT NULL",
            params![&hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };

    let Some((mime_type, relative_path)) = row else {
        return Ok(None);
    };

    let full_path = state.data_dir.join(relative_path);
    let bytes = std::fs::read(&full_path).map_err(|e| e.to_string())?;

    Ok(Some(AttachmentBytesResponse {
        hash,
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

#[derive(Clone, serde::Serialize)]
struct AttachmentDownloadedEvent {
    hash: String,
}

// Persist an attachment pulled from a peer (`attach-data`). The hash is the
// content address, so mismatched bytes are rejected outright. Emits
// `attachment-downloaded` so open editors can re-resolve the image.
#[tauri::command]
pub fn save_attachment_bytes(
    state: tauri::State<'_, AppState>,
    hash: String,
    mime_type: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| e.to_string())?;

    let actual = sha256_hex(&bytes);
    if actual != hash {
        return Err(format!(
            "attachment hash mismatch: expected {hash}, got {actual}"
        ));
    }

    let filename = format!("{}.{}", hash, ext_for_mime(&mime_type));
    let attachments_dir = state.data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    std::fs::write(attachments_dir.join(&filename), &bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("attachments/{}", filename);
    let now = current_timestamp();

    {
        let db = state.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
            params![&hash, &mime_type, &relative_path, now],
        )
        .map_err(|e| e.to_string())?;
    }

    let _ = state
        .app_handle
        .emit("attachment-downloaded", AttachmentDownloadedEvent { hash });
    Ok(())
}

fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
