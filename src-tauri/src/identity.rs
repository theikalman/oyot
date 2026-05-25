use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserIdentity {
    pub user_id: String,
    pub node_id: String,
    pub display_name: String,
}

pub fn get_or_create_identity(db: &rusqlite::Connection) -> Result<UserIdentity, String> {
    if let Some(identity) = load_identity(db)? {
        return Ok(identity);
    }

    let user_id = uuid::Uuid::new_v4().to_string();
    let node_id = uuid::Uuid::new_v4().to_string();
    let display_name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "My Device".to_string());

    db.execute(
        "INSERT INTO identity (user_id, node_id, display_name) VALUES (?, ?, ?)",
        params![&user_id, &node_id, &display_name],
    )
    .map_err(|e| e.to_string())?;

    Ok(UserIdentity {
        user_id,
        node_id,
        display_name,
    })
}

fn load_identity(db: &rusqlite::Connection) -> Result<Option<UserIdentity>, String> {
    let identity = db
        .query_row(
            "SELECT user_id, node_id, display_name FROM identity LIMIT 1",
            [],
            |row| {
                Ok(UserIdentity {
                    user_id: row.get(0)?,
                    node_id: row.get(1)?,
                    display_name: row.get(2)?,
                })
            },
        )
        .ok();
    Ok(identity)
}

pub fn update_display_name(db: &rusqlite::Connection, display_name: &str) -> Result<(), String> {
    db.execute(
        "UPDATE identity SET display_name = ? WHERE user_id = (SELECT user_id FROM identity LIMIT 1)",
        params![display_name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
