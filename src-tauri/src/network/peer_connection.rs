use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as TokioMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct PeerInfo {
    pub id: String,
    pub display_name: String,
    pub signaling_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PeerMessage {
    CrdtUpdate { doc_id: String, update: Vec<u8> },
    CrdtState { doc_id: String, state: Vec<u8> },
    RequestDoc { doc_id: String },
    RequestSync { doc_id: String },
    Ping,
    Pong,
}

#[allow(dead_code)]
pub struct PeerConnection {
    pub peer_id: String,
    pub sender: broadcast::Sender<PeerMessage>,
    pub receiver: Arc<TokioMutex<broadcast::Receiver<PeerMessage>>>,
}

impl PeerConnection {
    pub fn new(peer_id: String) -> (Self, broadcast::Sender<PeerMessage>) {
        let (tx, rx) = broadcast::channel(100);
        let receiver = rx.resubscribe();
        (
            Self {
                peer_id,
                sender: tx.clone(),
                receiver: Arc::new(TokioMutex::new(receiver)),
            },
            tx,
        )
    }

    #[allow(dead_code)]
    pub async fn recv(&self) -> Option<PeerMessage> {
        let mut rx = self.receiver.lock().await;
        rx.recv().await.ok()
    }
}

pub struct PeerRegistry {
    peers: Arc<TokioMutex<HashMap<String, Arc<PeerConnection>>>>,
    pub events: broadcast::Sender<PeerEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PeerEvent {
    Connected(String),
    Disconnected(String),
    Message { from: String, doc_id: String },
}

impl PeerRegistry {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(100);
        Self {
            peers: Arc::new(TokioMutex::new(HashMap::new())),
            events,
        }
    }

    pub async fn add_peer(&self, peer_id: String, _display_name: String) -> Arc<PeerConnection> {
        let (conn, _) = PeerConnection::new(peer_id.clone());
        let conn = Arc::new(conn);
        self.peers.lock().await.insert(peer_id.clone(), conn.clone());
        let _ = self.events.send(PeerEvent::Connected(peer_id));
        conn
    }

    pub async fn remove_peer(&self, peer_id: &str) {
        self.peers.lock().await.remove(peer_id);
        let _ = self.events.send(PeerEvent::Disconnected(peer_id.to_string()));
    }

    #[allow(dead_code)]
    pub async fn get_peer(&self, peer_id: &str) -> Option<Arc<PeerConnection>> {
        self.peers.lock().await.get(peer_id).cloned()
    }

    #[allow(dead_code)]
    pub async fn get_all_peers(&self) -> Vec<String> {
        self.peers.lock().await.keys().cloned().collect()
    }

    #[allow(dead_code)]
    pub async fn broadcast_to_all(&self, msg: PeerMessage, exclude: Option<&str>) {
        let peers = self.peers.lock().await;
        for (_, conn) in peers.iter() {
            if let Some(ex) = exclude {
                if conn.peer_id == ex {
                    continue;
                }
            }
            let _ = conn.sender.send(msg.clone());
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerEvent> {
        self.events.subscribe()
    }
}

impl Default for PeerRegistry {
    fn default() -> Self {
        Self::new()
    }
}