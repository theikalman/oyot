use parking_lot::Mutex;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

pub struct AttachmentManager {
    workspace_path: String,
    db: Arc<Mutex<rusqlite::Connection>>,
}

#[derive(Debug, Clone)]
pub struct AttachmentInfo {
    pub hash: String,
    pub mime_type: String,
    pub local_path: Option<String>,
    pub is_fully_downloaded: bool,
}

impl AttachmentManager {
    pub fn new(workspace_path: String, db: Arc<parking_lot::Mutex<rusqlite::Connection>>) -> Self {
        Self { workspace_path, db }
    }

    pub fn save_attachment(&self, data: &[u8], mime_type: &str) -> Result<String, String> {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let hash = hex::encode(hasher.finalize());

        let ext = self.extension_from_mime_type(mime_type);
        let filename = format!("{}.{}", hash, ext);

        let attachments_dir = PathBuf::from(&self.workspace_path).join("attachments");
        std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

        let full_path = attachments_dir.join(&filename);
        std::fs::write(&full_path, data).map_err(|e| e.to_string())?;

        let relative_path = format!("attachments/{}", filename);
        let now = current_timestamp();

        let db = self.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
            params![&hash, mime_type, &relative_path, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(hash)
    }

    pub fn get_attachment_path(&self, hash: &str) -> Option<PathBuf> {
        let db = self.db.lock();
        let result: Option<String> = db
            .query_row(
                "SELECT local_path FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
                params![hash],
                |row| row.get(0),
            )
            .ok()?;

        result.map(|p| PathBuf::from(&self.workspace_path).join(p))
    }

    pub fn get_attachment_info(&self, hash: &str) -> Option<AttachmentInfo> {
        let db = self.db.lock();
        db.query_row(
            "SELECT hash, mime_type, local_path, is_fully_downloaded FROM attachments WHERE hash = ?",
            params![hash],
            |row| {
                let local_path: Option<String> = row.get(2)?;
                let is_downloaded: i32 = row.get(3)?;
                Ok(AttachmentInfo {
                    hash: row.get(0)?,
                    mime_type: row.get(1)?,
                    local_path,
                    is_fully_downloaded: is_downloaded == 1,
                })
            },
        )
        .ok()
    }

    pub fn mark_downloaded(&self, hash: &str, local_path: &str) -> Result<(), String> {
        let db = self.db.lock();
        db.execute(
            "UPDATE attachments SET local_path = ?, is_fully_downloaded = 1 WHERE hash = ?",
            params![local_path, hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mark_not_downloaded(&self, hash: &str) -> Result<(), String> {
        let db = self.db.lock();
        db.execute(
            "UPDATE attachments SET is_fully_downloaded = 0 WHERE hash = ?",
            params![hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_undownloaded(&self) -> Vec<(String, String)> {
        let db = self.db.lock();
        let mut stmt = match db
            .prepare("SELECT hash, mime_type FROM attachments WHERE is_fully_downloaded = 0")
        {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        stmt.query_map([], |row| {
            let hash: String = row.get(0)?;
            let mime_type: String = row.get(1)?;
            Ok((hash, mime_type))
        })
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    pub fn list_all_hashes(&self) -> Vec<(String, String, bool)> {
        let db = self.db.lock();
        let mut stmt =
            match db.prepare("SELECT hash, mime_type, is_fully_downloaded FROM attachments") {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };

        stmt.query_map([], |row| {
            let hash: String = row.get(0)?;
            let mime_type: String = row.get(1)?;
            let is_downloaded: i32 = row.get(2)?;
            Ok((hash, mime_type, is_downloaded == 1))
        })
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    pub fn delete_attachment(&self, hash: &str) -> Result<(), String> {
        let local_path = self.get_attachment_path(hash);
        if let Some(path) = local_path {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }

        let db = self.db.lock();
        db.execute(
            "UPDATE attachments SET local_path = NULL, is_fully_downloaded = 0 WHERE hash = ?",
            params![hash],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_local_blob_data(&self, hash: &str) -> Option<Vec<u8>> {
        let path = self.get_attachment_path(hash)?;
        std::fs::read(&path).ok()
    }

    fn extension_from_mime_type(&self, mime_type: &str) -> &str {
        match mime_type {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            _ => "bin",
        }
    }
}

fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
