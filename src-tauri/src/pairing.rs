use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DevicePair {
    pub peer_node_id: String,
    pub peer_display_name: String,
    pub room_id: String,
    pub last_synchronized: Option<i64>,
}

pub fn load_pairs(db: &rusqlite::Connection, user_id: &str) -> Result<Vec<DevicePair>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, peer_display_name, room_id, last_synchronized
             FROM device_pairs WHERE user_id = ? ORDER BY last_synchronized DESC",
        )
        .map_err(|e| e.to_string())?;

    let pairs = stmt
        .query_map(params![user_id], |row| {
            Ok(DevicePair {
                peer_node_id: row.get(0)?,
                peer_display_name: row.get(1)?,
                room_id: row.get(2)?,
                last_synchronized: row.get(3).ok(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(pairs)
}

pub fn save_pair(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
    peer_display_name: &str,
    room_id: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
         VALUES (?, ?, ?, ?)",
        params![user_id, peer_node_id, peer_display_name, room_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_pair(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
) -> Result<(), String> {
    db.execute(
        "DELETE FROM device_pairs WHERE user_id = ? AND peer_node_id = ?",
        params![user_id, peer_node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_last_sync(db: &rusqlite::Connection, room_id: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    db.execute(
        "UPDATE device_pairs SET last_synchronized = ? WHERE room_id = ?",
        params![now, room_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub fn get_pair_by_room(
    db: &rusqlite::Connection,
    room_id: &str,
) -> Result<Option<DevicePair>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, peer_display_name, room_id, last_synchronized
             FROM device_pairs WHERE room_id = ?",
        )
        .map_err(|e| e.to_string())?;
    let pair = stmt
        .query_row(params![room_id], |row| {
            Ok(DevicePair {
                peer_node_id: row.get(0)?,
                peer_display_name: row.get(1)?,
                room_id: row.get(2)?,
                last_synchronized: row.get(3).ok(),
            })
        })
        .ok();
    Ok(pair)
}

use sha2::{Digest, Sha256};

pub fn derive_room_id(user_a: &str, user_b: &str) -> String {
    let mut ids = vec![user_a, user_b];
    ids.sort();
    let combined = ids.join(":");
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..16])
}
