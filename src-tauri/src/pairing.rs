use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DevicePair {
    pub peer_node_id: String,
    pub peer_display_name: String,
    pub room_id: String,
    pub last_synchronized: Option<i64>,
    /// The user disconnected it: neither dialled nor let in until they
    /// reconnect it (ADR 0032, decision 10).
    #[serde(default)]
    pub disconnected: bool,
}

pub fn load_pairs(db: &rusqlite::Connection, user_id: &str) -> Result<Vec<DevicePair>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, peer_display_name, room_id, last_synchronized, disconnected
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
                disconnected: row.get::<_, i64>(4).unwrap_or(0) != 0,
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
    // Upsert rather than INSERT OR REPLACE: REPLACE deletes the row and inserts
    // a fresh one, and `last_synchronized` is not in the column list, so it
    // reset to NULL. The webview's transport called this on every transition
    // to connected, so "last synced" flipped to never-synced on every
    // reconnect; a device pairing again with one that still has it would do
    // the same.
    db.execute(
        "INSERT INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, peer_node_id) DO UPDATE SET
             peer_display_name = excluded.peer_display_name,
             room_id           = excluded.room_id",
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

/// Whether the user disconnected this device (ADR 0032, decision 10): it is
/// neither dialled nor let in until they reconnect it.
pub fn is_disconnected(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
) -> Result<bool, String> {
    let flag: Option<i64> = db
        .query_row(
            "SELECT disconnected FROM device_pairs WHERE user_id = ? AND peer_node_id = ?",
            params![user_id, peer_node_id],
            |row| row.get(0),
        )
        .ok();
    Ok(flag == Some(1))
}

pub fn set_disconnected(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
    disconnected: bool,
) -> Result<(), String> {
    db.execute(
        "UPDATE device_pairs SET disconnected = ? WHERE user_id = ? AND peer_node_id = ?",
        params![disconnected, user_id, peer_node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_pair_by_node_id(
    db: &rusqlite::Connection,
    user_id: &str,
    peer_node_id: &str,
) -> Result<Option<DevicePair>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, peer_display_name, room_id, last_synchronized, disconnected
             FROM device_pairs WHERE user_id = ? AND peer_node_id = ?",
        )
        .map_err(|e| e.to_string())?;
    let pair = stmt
        .query_row(params![user_id, peer_node_id], |row| {
            Ok(DevicePair {
                peer_node_id: row.get(0)?,
                peer_display_name: row.get(1)?,
                room_id: row.get(2)?,
                last_synchronized: row.get(3).ok(),
                disconnected: row.get::<_, i64>(4).unwrap_or(0) != 0,
            })
        })
        .ok();
    Ok(pair)
}

#[allow(dead_code)]
pub fn get_pair_by_room(
    db: &rusqlite::Connection,
    room_id: &str,
) -> Result<Option<DevicePair>, String> {
    let mut stmt = db
        .prepare(
            "SELECT peer_node_id, peer_display_name, room_id, last_synchronized, disconnected
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
                disconnected: row.get::<_, i64>(4).unwrap_or(0) != 0,
            })
        })
        .ok();
    Ok(pair)
}

use sha2::{Digest, Sha256};

pub fn derive_room_id(user_a: &str, user_b: &str) -> String {
    let mut ids = [user_a, user_b];
    ids.sort();
    let combined = ids.join(":");
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..16])
}
