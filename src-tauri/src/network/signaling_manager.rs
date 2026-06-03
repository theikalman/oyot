use crate::network::mqtt_client::{MqttEvent, MqttSignalingClient, SignalingMessage};
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerAnnouncement {
    pub user_id: String,
    pub node_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum SignalingEvent {
    Offer { from: String, sdp: String, room_id: String },
    Answer { from: String, sdp: String },
    IceCandidate { from: String, candidate: String },
    PeerJoined { peer_id: String, user_id: String, display_name: String },
    PeerLeft { peer_id: String },
}

enum PublishRequest {
    Offer { topic: String, payload: Vec<u8> },
    Answer { topic: String, payload: Vec<u8> },
    IceCandidate { topic: String, payload: Vec<u8> },
    PeerJoined { topic: String, payload: Vec<u8> },
    PeerLeft { topic: String, payload: Vec<u8> },
}

pub struct SignalingManager {
    mqtt_client: Arc<ParkingMutex<Option<MqttSignalingClient>>>,
    event_tx: broadcast::Sender<SignalingEvent>,
    node_id: Arc<ParkingMutex<String>>,
    user_id: Arc<ParkingMutex<String>>,
    display_name: Arc<ParkingMutex<String>>,
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
            display_name: Arc::new(ParkingMutex::new(String::new())),
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

    pub fn set_display_name(&self, name: String) {
        *self.display_name.lock() = name;
    }

    pub fn get_node_id(&self) -> String {
        self.node_id.lock().clone()
    }

    #[allow(dead_code)]
    pub fn get_user_id(&self) -> String {
        self.user_id.lock().clone()
    }

    #[allow(dead_code)]
    pub fn get_display_name(&self) -> String {
        self.display_name.lock().clone()
    }

    pub async fn connect(&self, broker_url: &str, node_id: &str) -> Result<(), String> {
        let client = MqttSignalingClient::new(broker_url, node_id).await?;
        
        client.subscribe(&format!("signaling/{}", node_id)).await?;
        client.subscribe("signaling/global").await?;
        client.subscribe("signaling/+/offer").await?;
        client.subscribe("signaling/+/answer").await?;
        client.subscribe("signaling/+/ice-candidate").await?;
        client.subscribe("signaling/online").await?;

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
                        PublishRequest::PeerJoined { topic, payload } => (topic, payload),
                        PublishRequest::PeerLeft { topic, payload } => (topic, payload),
                    };
                    if let Err(e) = c.publish(&topic, &payload).await {
                        eprintln!("MQTT publish error: {}", e);
                    }
                }
            }
        });

        *self.publish_tx.lock() = Some(publish_tx);

        let mut event_rx = client.subscribe_to_events();
        *self.mqtt_client.lock() = Some(client);

        let user_id = self.user_id.clone();
        let node_id_str = node_id.to_string();
        let display_name = self.display_name.lock().clone();
        let publish_tx = self.publish_tx.lock().clone();

        if let Some(app_handle) = &self.app_handle {
            let app = app_handle.clone();
            let user_id_clone = user_id.clone();
            let node_id_clone = node_id_str.clone();
            tokio::spawn(async move {
                while let Ok(event) = event_rx.recv().await {
                    match event {
                        MqttEvent::Connected => {
                            eprintln!("[Signaling] MQTT Connected");
                            let _ = app.emit("mqtt-status", "connected");
                        }
                        MqttEvent::Disconnected => {
                            let _ = app.emit("mqtt-status", "disconnected");
                        }
                        MqttEvent::Message { topic, msg } => {
                            eprintln!("[Signaling] Received MQTT message on topic '{}': {:?}", topic, msg.msg_type);
                            if topic == "signaling/online" && msg.msg_type == "peer-joined" {
                                eprintln!("[Signaling] Processing peer-joined message: {}", msg.payload);
                                if let Ok(announcement) = serde_json::from_str::<PeerAnnouncement>(&msg.payload) {
                                    eprintln!("[Signaling] Peer joined: {} ({})", announcement.display_name, announcement.node_id);
                                    if announcement.node_id != node_id_clone {
                                        let _ = app.emit("mqtt-peer-joined", serde_json::json!({
                                            "peer_id": announcement.node_id,
                                            "user_id": announcement.user_id,
                                            "display_name": announcement.display_name
                                        }));
                                    }
                                } else {
                                    eprintln!("[Signaling] Failed to parse peer announcement: {:?}", msg.payload);
                                }
                            } else if topic == "signaling/online" && msg.msg_type == "peer-left" {
                                if let Ok(announcement) = serde_json::from_str::<PeerAnnouncement>(&msg.payload) {
                                    let _ = app.emit("mqtt-peer-left", announcement.node_id);
                                }
                            } else {
                                let uid = user_id_clone.lock().clone();
                                Self::handle_message(&app, msg, uid).await;
                            }
                        }
                    }
                }
            });

            let uid_for_publish = user_id.clone();
            let node_id_for_publish = node_id_str.clone();
            let display_name_for_publish = display_name.clone();
            let publish_tx_clone = publish_tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                eprintln!("[Signaling] Publishing peer joined for {}...", node_id_for_publish);
                let uid_val = uid_for_publish.lock().clone();
                if uid_val.is_empty() || node_id_for_publish.is_empty() {
                    eprintln!("[Signaling] Skipping peer joined publish - identity not set");
                    return;
                }
                let announcement = PeerAnnouncement {
                    user_id: uid_val,
                    node_id: node_id_for_publish.clone(),
                    display_name: display_name_for_publish.clone(),
                };
                let msg = SignalingMessage {
                    from: node_id_for_publish.clone(),
                    to: None,
                    msg_type: "peer-joined".to_string(),
                    payload: serde_json::to_string(&announcement).unwrap_or_default(),
                };
                let topic = "signaling/online".to_string();
                let payload = serde_json::to_vec(&msg).unwrap_or_default();
                if let Some(tx) = publish_tx_clone {
                    if let Err(e) = tx.send(PublishRequest::PeerJoined { topic, payload }).await {
                        eprintln!("[Signaling] Failed to send peer joined: {}", e);
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
            _ => {}
        }
    }

    #[allow(dead_code)]
    pub async fn publish_peer_joined(&self) -> Result<(), String> {
        let user_id = self.user_id.lock().clone();
        let node_id = self.node_id.lock().clone();
        let display_name = self.display_name.lock().clone();

        if user_id.is_empty() || node_id.is_empty() {
            return Ok(());
        }

        let announcement = PeerAnnouncement {
            user_id,
            node_id: node_id.clone(),
            display_name,
        };

        let msg = SignalingMessage {
            from: node_id,
            to: None,
            msg_type: "peer-joined".to_string(),
            payload: serde_json::to_string(&announcement).map_err(|e| e.to_string())?,
        };

        let topic = "signaling/online".to_string();
        let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        
        let tx_opt = self.publish_tx.lock().clone();
        if let Some(tx) = tx_opt {
            tx.send(PublishRequest::PeerJoined { topic, payload }).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn publish_peer_left(&self) -> Result<(), String> {
        let user_id = self.user_id.lock().clone();
        let node_id = self.node_id.lock().clone();
        let display_name = self.display_name.lock().clone();

        if user_id.is_empty() || node_id.is_empty() {
            return Ok(());
        }

        let announcement = PeerAnnouncement {
            user_id,
            node_id: node_id.clone(),
            display_name,
        };

        let msg = SignalingMessage {
            from: node_id.clone(),
            to: None,
            msg_type: "peer-left".to_string(),
            payload: serde_json::to_string(&announcement).map_err(|e| e.to_string())?,
        };

        let topic = "signaling/online".to_string();
        let payload = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        
        let tx_opt = self.publish_tx.lock().clone();
        if let Some(tx) = tx_opt {
            tx.send(PublishRequest::PeerLeft { topic, payload }).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn disconnect(&self) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let _ = self.publish_peer_left().await;
        });
        *self.mqtt_client.lock() = None;
        *self.publish_tx.lock() = None;
    }

    pub fn is_connected(&self) -> bool {
        self.mqtt_client.lock().is_some()
    }

    pub async fn publish_offer(&self, peer_id: &str, sdp: &str, _from: &str) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        let msg = SignalingMessage {
            from: node_id,
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
        let node_id = self.node_id.lock().clone();
        let msg = SignalingMessage {
            from: node_id,
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
        let node_id = self.node_id.lock().clone();
        let msg = SignalingMessage {
            from: node_id,
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

    #[allow(dead_code)]
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