use crate::db_snapshot::DbSnapshot;
use crate::identity::IdentityInfo;
use crate::network::peer_connection::PeerRegistry;
use crate::network::signaling_client::SignalingClient;
use crate::network::signaling_manager::SignalingManager;
use crate::network::webrtc_manager::WebRtcManager;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub db: Arc<parking_lot::Mutex<Connection>>,
    pub snapshot: Arc<DbSnapshot>,
    pub webrtc_manager: Arc<WebRtcManager>,
    pub peer_registry: Arc<PeerRegistry>,
    #[allow(dead_code)]
    pub signaling_client: Arc<SignalingClient>,
    pub signaling_manager: Arc<SignalingManager>,
    #[allow(dead_code)]
    pub app_handle: AppHandle,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(app_handle: AppHandle, signaling_url: Option<String>) -> Result<Self, String> {
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

        let signaling_manager = Arc::new(SignalingManager::new(Some(app_handle.clone())));

        Ok(Self {
            db: db.clone(),
            snapshot: Arc::new(DbSnapshot::new(db.clone())),
            webrtc_manager: Arc::new(WebRtcManager::new(String::new())),
            peer_registry: Arc::new(PeerRegistry::new()),
            signaling_client: Arc::new(SignalingClient::new(signaling_url)),
            signaling_manager,
            app_handle,
            data_dir: app_data_dir,
        })
    }

    #[allow(dead_code)]
    pub fn get_identity(&self) -> Result<IdentityInfo, String> {
        let db_lock = self.db.lock();
        db_lock
            .query_row(
                "SELECT user_id, node_id, display_name FROM identity LIMIT 1",
                [],
                |row| {
                    Ok(IdentityInfo {
                        user_id: row.get(0)?,
                        node_id: row.get(1)?,
                        display_name: row.get(2)?,
                    })
                },
            )
            .map_err(|e| e.to_string())
    }
}
