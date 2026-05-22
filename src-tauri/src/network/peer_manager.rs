use rusqlite::params;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerInfo {
    pub node_id: String,
    pub device_name: String,
    pub last_synchronized: Option<i64>,
}

pub fn load_trusted_peers(db: &rusqlite::Connection) -> Result<Vec<PeerInfo>, String> {
    let mut stmt = db
        .prepare("SELECT node_id, device_name, last_synchronized FROM sync_peers")
        .map_err(|e| e.to_string())?;

    let peers = stmt
        .query_map([], |row| {
            Ok(PeerInfo {
                node_id: row.get(0)?,
                device_name: row.get(1)?,
                last_synchronized: row.get(2).ok(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(peers)
}

pub fn save_peer(
    db: &rusqlite::Connection,
    node_id: &str,
    device_name: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO sync_peers (node_id, device_name, last_synchronized) VALUES (?, ?, NULL)",
        params![node_id, device_name],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_peer(db: &rusqlite::Connection, node_id: &str) -> Result<(), String> {
    db.execute("DELETE FROM sync_peers WHERE node_id = ?", params![node_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub fn mark_peer_online(db: &rusqlite::Connection, node_id: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    db.execute(
        "UPDATE sync_peers SET last_synchronized = ? WHERE node_id = ?",
        params![now, node_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
