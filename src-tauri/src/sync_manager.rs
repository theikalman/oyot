use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPeer {
    pub node_id: String,
    pub device_name: String,
    pub last_synchronized: Option<i64>,
    pub is_online: bool,
}

#[derive(Debug, Clone)]
pub struct SyncManager {
    peers: Arc<Mutex<Vec<SyncPeer>>>,
    node_id: Option<String>,
    is_enabled: bool,
}

impl SyncManager {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(Mutex::new(Vec::new())),
            node_id: None,
            is_enabled: true,
        }
    }

    pub fn set_node_id(&mut self, node_id: String) {
        self.node_id = Some(node_id);
    }

    pub fn get_node_id(&self) -> Option<String> {
        self.node_id.clone()
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.is_enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.is_enabled
    }

    pub async fn add_peer(&self, node_id: String, device_name: String) -> Result<(), String> {
        let mut peers = self.peers.lock().await;
        if !peers.iter().any(|p| p.node_id == node_id) {
            peers.push(SyncPeer {
                node_id,
                device_name,
                last_synchronized: None,
                is_online: false,
            });
        }
        Ok(())
    }

    pub async fn remove_peer(&self, node_id: &str) -> Result<(), String> {
        let mut peers = self.peers.lock().await;
        peers.retain(|p| p.node_id != node_id);
        Ok(())
    }

    pub async fn get_peers(&self) -> Vec<SyncPeer> {
        self.peers.lock().await.clone()
    }
}

impl Default for SyncManager {
    fn default() -> Self {
        Self::new()
    }
}
