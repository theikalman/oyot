use crate::network::lan_discovery::LanDiscovery;
use crate::network::lan_signaling::LanListener;
use crate::network::peers::Peers;
use crate::network::remote_peers::RemoteProbe;
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
    /// Who this device can reach, by whichever route found them (ADR 0023).
    /// Every discovery source writes here and the signaling manager reads it.
    pub peers: Arc<Peers>,
    /// Discovery of this user's other devices on the local network (ADR 0018).
    pub lan: Arc<LanDiscovery>,
    /// The other way a device is found: an address the user stored for it,
    /// proved by a probe (ADR 0023).
    pub remote: Arc<RemoteProbe>,
    /// The local-network signaling listener, while one is running. Its port is
    /// what discovery advertises, so the two start and stop together.
    pub lan_listener: Arc<parking_lot::Mutex<Option<LanListener>>>,
    /// Identifies this run of the process in what we advertise, so a peer that
    /// restarted is not mistaken for the same one still sitting there.
    pub boot_id: String,
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

        let boot_id = uuid::Uuid::new_v4().to_string();
        let peers = Arc::new(Peers::new(Some(app_handle.clone())));
        let signaling_manager = Arc::new(SignalingManager::new(peers.clone()));
        let lan = Arc::new(LanDiscovery::new(Some(app_handle.clone()), peers.clone()));
        let remote = Arc::new(RemoteProbe::new(
            peers.clone(),
            db.clone(),
            signaling_manager.clone(),
            boot_id.clone(),
        ));

        Ok(Self {
            db: db.clone(),
            signaling_manager,
            peers,
            lan,
            remote,
            lan_listener: Arc::new(parking_lot::Mutex::new(None)),
            boot_id,
            app_handle,
            data_dir: app_data_dir,
        })
    }
}
