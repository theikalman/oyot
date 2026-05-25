use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex as TokioMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalingMessage {
    pub from: String,
    pub to: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerEntry {
    pub id: String,
    pub display_name: String,
}

pub struct SignalingClient {
    node_id: Arc<TokioMutex<Option<String>>>,
    user_id: Arc<TokioMutex<Option<String>>>,
    server_url: Arc<TokioMutex<Option<String>>,
    is_connected: Arc<TokioMutex<bool>>,
    pub outbound: mpsc::Sender<SignalingMessage>,
    pub inbound: broadcast::Sender<SignalingMessage>,
}

impl SignalingClient {
    pub fn new(server_url: Option<String>) -> Self {
        let (outbound_tx, _outbound_rx) = mpsc::channel(100);
        let (inbound_tx, _) = broadcast::channel(100);

        Self {
            node_id: Arc::new(TokioMutex::new(None)),
            user_id: Arc::new(TokioMutex::new(None)),
            server_url: Arc::new(TokioMutex::new(server_url)),
            is_connected: Arc::new(TokioMutex::new(false)),
            outbound: outbound_tx,
            inbound: inbound_tx,
        }
    }

    pub async fn set_server_url(&self, url: Option<String>) {
        *self.server_url.lock().await = url;
    }

    pub async fn get_server_url(&self) -> Option<String> {
        self.server_url.lock().await.clone()
    }

    pub async fn get_node_id(&self) -> Option<String> {
        self.node_id.lock().await.clone()
    }

    pub async fn set_node_id(&self, node_id: String) {
        *self.node_id.lock().await = Some(node_id);
    }

    pub async fn set_user_id(&self, user_id: String) {
        *self.user_id.lock().await = Some(user_id);
    }

    pub async fn get_user_id(&self) -> Option<String> {
        self.user_id.lock().await.clone()
    }

    pub fn is_connected(&self) -> bool {
        *self.is_connected.lock()
    }

    pub fn set_connected(&self, connected: bool) {
        *self.is_connected.lock() = connected;
    }

    pub async fn send_message(&self, msg: SignalingMessage) -> Result<(), String> {
        self.outbound
            .try_send(msg)
            .map_err(|_| "Failed to queue signaling message".to_string())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SignalingMessage> {
        self.inbound.subscribe()
    }
}