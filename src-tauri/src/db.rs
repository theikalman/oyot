use crate::attachment_manager::AttachmentManager;
use crate::network::gossip_broadcaster::GossipBroadcaster;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex as TokioMutex;

pub struct AppState {
    pub workspace_path: String,
    pub db: Arc<parking_lot::Mutex<Connection>>,
    pub sync_manager: Arc<TokioMutex<crate::sync_manager::SyncManager>>,
    pub iroh_endpoint: Option<Arc<iroh::Endpoint>>,
    pub gossip_broadcaster: Option<Arc<GossipBroadcaster>>,
    pub attachment_manager: Arc<AttachmentManager>,
    pub app_handle: AppHandle,
}

impl AppState {
    pub fn new(workspace_path: String, app_handle: AppHandle) -> Result<Self, String> {
        let db_path = get_db_path(&workspace_path);
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let db = Arc::new(parking_lot::Mutex::new(conn));
        Ok(Self {
            workspace_path: workspace_path.clone(),
            db: db.clone(),
            sync_manager: Arc::new(TokioMutex::new(crate::sync_manager::SyncManager::new())),
            iroh_endpoint: None,
            gossip_broadcaster: None,
            attachment_manager: Arc::new(AttachmentManager::new(workspace_path, db)),
            app_handle,
        })
    }
}

pub fn get_db_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join("oyot.db")
}
