use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub workspace_path: String,
    pub db: Arc<Mutex<Connection>>,
}

impl AppState {
    pub fn new(workspace_path: String) -> Result<Self, String> {
        let db_path = get_db_path(&workspace_path);
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Ok(Self {
            workspace_path,
            db: Arc::new(Mutex::new(conn)),
        })
    }
}

pub fn get_db_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join("oyot.db")
}
