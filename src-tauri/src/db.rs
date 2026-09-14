use crate::network::signaling_manager::SignalingManager;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Connection settings applied once at open. None of these were set before, so
/// the database ran with SQLite's defaults: rollback journalling, and foreign
/// keys OFF, so no `ON DELETE CASCADE` in the schema had ever actually fired.
pub fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("Failed to configure the database connection: {e}"))
}

pub struct AppState {
    pub db: Arc<parking_lot::Mutex<Connection>>,
    pub signaling_manager: Arc<SignalingManager>,
    #[allow(dead_code)]
    pub app_handle: AppHandle,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Result<Self, String> {
        let app_data_dir = match app_handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(_) => return Err("Failed to get app data dir".into()),
        };
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;

        let attachments_dir = app_data_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;

        let db_path = app_data_dir.join("oyot.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn)?;
        let db = Arc::new(parking_lot::Mutex::new(conn));

        let signaling_manager = Arc::new(SignalingManager::new(Some(app_handle.clone())));

        Ok(Self {
            db: db.clone(),
            signaling_manager,
            app_handle,
            data_dir: app_data_dir,
        })
    }
}
