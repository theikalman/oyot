use crate::network::mqtt_client::{MqttEvent, MqttSignalingClient, SignalingMessage};
use parking_lot::Mutex as ParkingMutex;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};

#[derive(Debug, Clone)]
pub enum SignalingEvent {
    Offer { from: String, sdp: String, room_id: String },
    Answer { from: String, sdp: String },
    IceCandidate { from: String, candidate: String },
    PeerJoined { peer_id: String },
    PeerLeft { peer_id: String },
}

enum PublishRequest {
    Offer { topic: String, payload: Vec<u8> },
    Answer { topic: String, payload: Vec<u8> },
    IceCandidate { topic: String, payload: Vec<u8> },
}

pub struct SignalingManager {
    mqtt_client: Arc<ParkingMutex<Option<MqttSignalingClient>>>,
    event_tx: broadcast::Sender<SignalingEvent>,
    node_id: Arc<ParkingMutex<String>>,
    user_id: Arc<ParkingMutex<String>>,
    app_handle: Option<AppHandle>,
    publish_tx: Arc<ParkingMutex<Option<mpsc::Sender<PublishRequest>>>>,
}

impl SignalingManager {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        let (event_tx, _) = broadcast::channel(100);
        Self {
            mqtt_client: Arc::new(ParkingMutex::new(None)),
            event_tx,
            node_id: Arc::new(ParkingMutex::new(String::new())),
            user_id: Arc::new(ParkingMutex::new(String::new())),
            app_handle,
            publish_tx: Arc::new(ParkingMutex::new(None)),
        }
    }

    pub fn set_node_id(&self, node_id: String) {
        *self.node_id.lock() = node_id;
    }

    pub fn set_user_id(&self, user_id: String) {
        *self.user_id.lock() = user_id;
    }

    pub fn get_node_id(&self) -> String {
        self.node_id.lock().clone()
    }

    pub fn get_user_id(&self) -> String {
        self.user_id.lock().clone()
    }

    pub async fn connect(&self, broker_url: &str, node_id: &str) -> Result<(), String> {
        let client = MqttSignalingClient::new(broker_url, node_id).await?;
        
        client.subscribe(&format!("signaling/{}", node_id)).await?;
        client.subscribe("signaling/global").await?;
        client.subscribe("signaling/+/offer").await?;
        client.subscribe("signaling/+/answer").await?;
        client.subscribe("signaling/+/ice-candidate").await?;

        let (publish_tx, mut publish_rx) = mpsc::channel::<PublishRequest>(100);
        let mqtt_client_clone = self.mqtt_client.clone();
        
        tokio::spawn(async move {
            while let Some(req) = publish_rx.recv().await {
                let client_opt = mqtt_client_clone.lock().clone();
                if let Some(c) = client_opt {
                    let (topic, payload) = match req {
                        PublishRequest::Offer { topic, payload } => (topic, payload),
                        PublishRequest::Answer { topic, payload } => (topic, payload),
                        PublishRequest::IceCandidate { topic, payload } => (topic, payload),
                    };
                    if let Err(e) = c.publish(&topic, &payload).await {
                        eprintln!("MQTT publish error: {}", e);
                    }
                }
            }
        });

        *self.publish_tx.lock() = Some(publish_tx);

        let event_rx = client.subscribe_to_events();
        *self.mqtt_client.lock() = Some(client);

        if let Some(app_handle) = &self.app_handle {
            let app = app_handle.clone();
            let user_id = self.user_id.clone();
            tokio::spawn(async move {
                let mut event_rx = event_rx;
                while let Ok(event) = event_rx.recv().await {
                    match event {
                        MqttEvent::Connected => {
                            let _ = app.emit("mqtt-status", "connected");
                        }
                        MqttEvent::Disconnected => {
                            let _ = app.emit("mqtt-status", "disconnected");
                        }
                        MqttEvent::Message { topic: _, msg } => {
                            let uid = user_id.lock().clone();
                            Self::handle_message(&app, msg, uid).await;
                        }
                    }
                }
            });
        }

        Ok(())
    }

    async fn handle_message(app: &AppHandle, msg: SignalingMessage, our_user_id: String) {
        match msg.msg_type.as_str() {
            "offer" => {
                let room_id = derive_room_id(&our_user_id, &msg.from);
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
                    "room_id": room_id,
                });
                let _ = app.emit("mqtt-offer-received", payload);
            }
            "answer" => {
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
                });
                let _ = app.emit("mqtt-answer-received", payload);
            }
            "ice-candidate" => {
                let payload = serde_json::json!({
                    "from": msg.from,
                    "candidate": msg.payload,
                });
                let _ = app.emit("mqtt-ice-candidate-received", payload);
            }
            "peer-joined" => {
                let _ = app.emit("mqtt-peer-joined", msg.payload);
            }
            "peer-left" => {
                let _ = app.emit("mqtt-peer-left", msg.payload);
            }
            _ => {}
        }
    }

    pub fn disconnect(&self) {
        *self.mqtt_client.lock() = None;
        *self.publish_tx.lock() = None;
    }

    pub fn is_connected(&self) -> bool {
        self.mqtt_client.lock().is_some()
    }

    pub async fn publish_offer(&self, peer_id: &str, sdp: &str, _from: &str) -> Result<(), String> {
        let msg = SignalingMessage {
            from: peer_id.to_string(),
            to: Some(peer_id.to_string()),
            msg_type: "offer".to_string(),
            payload: sdp.to_string(),
        };
        let topic = format!("signaling/{}/offer", peer_id);
        let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        
        let tx_opt = self.publish_tx.lock().clone();
        if let Some(tx) = tx_opt {
            tx.send(PublishRequest::Offer { topic, payload }).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn publish_answer(&self, peer_id: &str, sdp: &str, _from: &str) -> Result<(), String> {
        let msg = SignalingMessage {
            from: peer_id.to_string(),
            to: Some(peer_id.to_string()),
            msg_type: "answer".to_string(),
            payload: sdp.to_string(),
        };
        let topic = format!("signaling/{}/answer", peer_id);
        let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        
        let tx_opt = self.publish_tx.lock().clone();
        if let Some(tx) = tx_opt {
            tx.send(PublishRequest::Answer { topic, payload }).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn publish_ice_candidate(&self, peer_id: &str, candidate: &str, _from: &str) -> Result<(), String> {
        let msg = SignalingMessage {
            from: peer_id.to_string(),
            to: Some(peer_id.to_string()),
            msg_type: "ice-candidate".to_string(),
            payload: candidate.to_string(),
        };
        let topic = format!("signaling/{}/ice-candidate", peer_id);
        let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        
        let tx_opt = self.publish_tx.lock().clone();
        if let Some(tx) = tx_opt {
            tx.send(PublishRequest::IceCandidate { topic, payload }).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn subscribe_to_events(&self) -> broadcast::Receiver<SignalingEvent> {
        self.event_tx.subscribe()
    }
}

fn derive_room_id(user_a: &str, user_b: &str) -> String {
    let mut sorted = vec![user_a.to_string(), user_b.to_string()];
    sorted.sort();
    let combined = sorted.join(":");
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..16])
}