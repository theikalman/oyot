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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SyncMessage {
    RequestStateVector { doc_id: String },
    SendStateVector { doc_id: String, state_vector: Vec<u8> },
    SendDelta { doc_id: String, delta: Vec<u8> },
    AckSync { doc_id: String },
}

pub struct SyncManager {
    peers: Arc<Mutex<Vec<SyncPeer>>>,
    node_id: Option<String>,
}

impl SyncManager {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(Mutex::new(Vec::new())),
            node_id: None,
        }
    }

    pub fn set_node_id(&mut self, node_id: String) {
        self.node_id = Some(node_id);
    }

    pub fn get_node_id(&self) -> Option<String> {
        self.node_id.clone()
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

    pub async fn mark_peer_online(&self, node_id: &str) {
        let mut peers = self.peers.lock().await;
        if let Some(peer) = peers.iter_mut().find(|p| p.node_id == node_id) {
            peer.is_online = true;
        }
    }

    pub async fn mark_peer_offline(&self, node_id: &str) {
        let mut peers = self.peers.lock().await;
        if let Some(peer) = peers.iter_mut().find(|p| p.node_id == node_id) {
            peer.is_online = false;
        }
    }

    pub async fn update_last_sync(&self, node_id: &str) {
        let mut peers = self.peers.lock().await;
        if let Some(peer) = peers.iter_mut().find(|p| p.node_id == node_id) {
            peer.last_synchronized = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            );
        }
    }
}

impl Default for SyncManager {
    fn default() -> Self {
        Self::new()
    }
}

pub fn encode_message(msg: &SyncMessage) -> Vec<u8> {
    bincode::serialize(msg).unwrap_or_default()
}

pub fn decode_message(data: &[u8]) -> Result<SyncMessage, String> {
    bincode::deserialize(data).map_err(|e| e.to_string())
}