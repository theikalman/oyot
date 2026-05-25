use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as TokioMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WebRtcMessage {
    CrdtUpdate { doc_id: String, update: Vec<u8> },
    CrdtStateRequest { doc_id: String },
    CrdtStateResponse { doc_id: String, state: Vec<u8> },
    Ping,
    Pong,
}

pub struct DataChannel {
    pub peer_id: String,
    pub sender: broadcast::Sender<WebRtcMessage>,
    pub receiver: Arc<TokioMutex<broadcast::Receiver<WebRtcMessage>>>,
}

impl DataChannel {
    pub fn new(peer_id: String) -> (Self, broadcast::Sender<WebRtcMessage>) {
        let (tx, rx) = broadcast::channel(500);
        (
            Self {
                peer_id,
                sender: tx.clone(),
                receiver: Arc::new(TokioMutex::new(rx.resubscribe())),
            },
            tx,
        )
    }

    pub async fn recv(&self) -> Option<WebRtcMessage> {
        let mut rx = self.receiver.lock().await;
        rx.recv().await.ok()
    }
}

pub struct WebRtcManager {
    node_id: String,
    channels: Arc<TokioMutex<HashMap<String, Arc<DataChannel>>>>,
    pub events: broadcast::Sender<RtcEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RtcEvent {
    PeerConnected(String),
    PeerDisconnected(String),
    DataReceived { from: String, doc_id: String },
    Error { peer_id: String, error: String },
}

impl WebRtcManager {
    pub fn new(node_id: String) -> Self {
        let (events, _) = broadcast::channel(100);
        Self {
            node_id,
            channels: Arc::new(TokioMutex::new(HashMap::new())),
            events,
        }
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    pub async fn register_channel(&self, peer_id: String) -> Arc<DataChannel> {
        let (channel, _) = DataChannel::new(peer_id.clone());
        let channel = Arc::new(channel);
        self.channels.lock().await.insert(peer_id.clone(), channel.clone());
        let _ = self.events.send(RtcEvent::PeerConnected(peer_id));
        channel
    }

    pub async fn unregister_channel(&self, peer_id: &str) {
        self.channels.lock().await.remove(peer_id);
        let _ = self.events.send(RtcEvent::PeerDisconnected(peer_id.to_string()));
    }

    pub async fn get_channel(&self, peer_id: &str) -> Option<Arc<DataChannel>> {
        self.channels.lock().await.get(peer_id).cloned()
    }

    pub async fn broadcast_message(&self, msg: WebRtcMessage, exclude: Option<&str>) {
        let channels = self.channels.lock().await.clone();
        for (peer_id, channel) in channels {
            if let Some(ex) = exclude {
                if peer_id == ex {
                    continue;
                }
            }
            let _ = channel.sender.send(msg.clone());
        }
    }

    pub async fn send_to_peer(&self, peer_id: &str, msg: WebRtcMessage) -> Result<(), String> {
        let channels = self.channels.lock().await;
        if let Some(channel) = channels.get(peer_id) {
            channel.sender.send(msg).map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err(format!("Peer {} not found", peer_id))
        }
    }

    pub async fn get_connected_peers(&self) -> Vec<String> {
        self.channels.lock().await.keys().cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RtcEvent> {
        self.events.subscribe()
    }
}