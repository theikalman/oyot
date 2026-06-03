use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub struct DbSnapshot {
    db: Arc<parking_lot::Mutex<Connection>>,
}

const SNAPSHOT_THRESHOLD: i64 = 50;

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct SnapshotResult {
    pub doc_id: String,
    pub snapshot_blob: Vec<u8>,
    pub last_update_id: i64,
}

impl DbSnapshot {
    pub fn new(db: Arc<parking_lot::Mutex<Connection>>) -> Self {
        Self { db }
    }

    pub fn count_updates(&self, doc_id: &str) -> Result<i64, String> {
        let db = self.db.lock();
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM yjs_updates WHERE document_id = ?",
                [doc_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count)
    }

    pub fn get_latest_update_id(&self, doc_id: &str) -> Result<i64, String> {
        let db = self.db.lock();
        let id: Option<i64> = db
            .query_row(
                "SELECT MAX(id) FROM yjs_updates WHERE document_id = ?",
                [doc_id],
                |row| row.get(0),
            )
            .ok();
        Ok(id.unwrap_or(0))
    }

    pub fn append_update(&self, doc_id: &str, update_blob: &[u8]) -> Result<i64, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let db = self.db.lock();
        db.execute(
            "INSERT INTO yjs_updates (document_id, update_blob, created_at) VALUES (?, ?, ?)",
            rusqlite::params![doc_id, update_blob, now],
        )
        .map_err(|e| e.to_string())?;

        let id = db.last_insert_rowid();
        Ok(id)
    }

    pub fn get_all_updates(&self, doc_id: &str) -> Result<Vec<Vec<u8>>, String> {
        let db = self.db.lock();
        let mut stmt = db
            .prepare("SELECT update_blob FROM yjs_updates WHERE document_id = ? ORDER BY id ASC")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([doc_id], |row| row.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?;

        let mut updates = Vec::new();
        for row in rows {
            if let Ok(blob) = row {
                updates.push(blob);
            }
        }
        Ok(updates)
    }

    #[allow(dead_code)]
    pub fn get_snapshot(&self, doc_id: &str) -> Result<Option<Vec<u8>>, String> {
        let db = self.db.lock();
        let blob: Option<Vec<u8>> = db
            .query_row(
                "SELECT snapshot_blob FROM yjs_snapshots WHERE document_id = ?",
                [doc_id],
                |row| row.get(0),
            )
            .ok();
        Ok(blob)
    }

    pub fn save_snapshot(
        &self,
        doc_id: &str,
        snapshot_blob: &[u8],
        last_update_id: i64,
    ) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let db = self.db.lock();
        db.execute(
            "INSERT OR REPLACE INTO yjs_snapshots (document_id, snapshot_blob, last_update_id, updated_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![doc_id, snapshot_blob, last_update_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn consolidate(&self, doc_id: &str, merged_state: &[u8]) -> Result<(), String> {
        let last_update_id = self.get_latest_update_id(doc_id)?;
        self.save_snapshot(doc_id, merged_state, last_update_id)?;

        let db = self.db.lock();
        db.execute("DELETE FROM yjs_updates WHERE document_id = ?", [doc_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn check_and_consolidate(&self, doc_id: &str, merged_state: &[u8]) -> Result<bool, String> {
        let count = self.count_updates(doc_id)?;
        if count >= SNAPSHOT_THRESHOLD {
            self.consolidate(doc_id, merged_state)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn delete_document_data(&self, doc_id: &str) -> Result<(), String> {
        let db = self.db.lock();
        db.execute("DELETE FROM yjs_updates WHERE document_id = ?", [doc_id])
            .map_err(|e| e.to_string())?;
        db.execute("DELETE FROM yjs_snapshots WHERE document_id = ?", [doc_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
