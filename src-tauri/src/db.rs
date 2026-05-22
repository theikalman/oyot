use crate::network::gossip_broadcaster::GossipBroadcaster;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

pub struct AppState {
    pub workspace_path: String,
    pub db: Arc<parking_lot::Mutex<Connection>>,
    pub sync_manager: Arc<TokioMutex<crate::sync_manager::SyncManager>>,
    pub iroh_endpoint: Option<Arc<iroh::Endpoint>>,
    pub gossip_broadcaster: Option<Arc<GossipBroadcaster>>,
}

impl AppState {
    pub fn new(workspace_path: String) -> Result<Self, String> {
        let db_path = get_db_path(&workspace_path);
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Ok(Self {
            workspace_path,
            db: Arc::new(parking_lot::Mutex::new(conn)),
            sync_manager: Arc::new(TokioMutex::new(crate::sync_manager::SyncManager::new())),
            iroh_endpoint: None,
            gossip_broadcaster: None,
        })
    }
}

pub fn get_db_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join("oyot.db")
}

pub fn with_connection<T>(state: &AppState, f: impl FnOnce(&Connection) -> T) -> T {
    let db = state.db.lock();
    f(&db)
}
