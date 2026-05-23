use crate::network::gossip_broadcaster::GossipBroadcaster;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as TokioMutex;

pub struct AppState {
    pub db: Arc<parking_lot::Mutex<Connection>>,
    pub sync_manager: Arc<TokioMutex<crate::sync_manager::SyncManager>>,
    pub iroh_endpoint: Option<Arc<iroh::Endpoint>>,
    pub gossip_broadcaster: Option<Arc<GossipBroadcaster>>,
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
        let db = Arc::new(parking_lot::Mutex::new(conn));
        Ok(Self {
            db: db.clone(),
            sync_manager: Arc::new(TokioMutex::new(crate::sync_manager::SyncManager::new())),
            iroh_endpoint: None,
            gossip_broadcaster: None,
            app_handle,
            data_dir: app_data_dir,
        })
    }
}
