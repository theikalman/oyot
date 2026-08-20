use crate::db::AppState;
use crate::network::mqtt_client::{MqttEvent, MqttSignalingClient, SignalingMessage};
use crate::pairing;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
struct PeerContext {
    user_id: String,
    display_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PairPayload {
    user_id: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    accepted: Option<bool>,
}

pub struct SignalingManager {
    mqtt_client: Arc<ParkingMutex<Option<MqttSignalingClient>>>,
    node_id: Arc<ParkingMutex<String>>,
    user_id: Arc<ParkingMutex<String>>,
    display_name: Arc<ParkingMutex<String>>,
    app_handle: Option<AppHandle>,
    publish_tx: Arc<ParkingMutex<Option<mpsc::Sender<(String, Vec<u8>)>>>>,
    // Peers we've explicitly agreed to pair with during this session (accepted a
    // pair-request from them, or had our pair-request accepted). Consulted when an
    // "offer" arrives from a node_id that isn't already in the persisted device_pairs
    // table, so unsolicited offers from unpaired/unauthorized nodes get dropped instead
    // of silently auto-accepted.
    authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
}

impl SignalingManager {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        Self {
            mqtt_client: Arc::new(ParkingMutex::new(None)),
            node_id: Arc::new(ParkingMutex::new(String::new())),
            user_id: Arc::new(ParkingMutex::new(String::new())),
            display_name: Arc::new(ParkingMutex::new(String::new())),
            app_handle,
            publish_tx: Arc::new(ParkingMutex::new(None)),
            authorized_peers: Arc::new(ParkingMutex::new(HashMap::new())),
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

    /// Records that we've agreed to pair with `node_id` this session, so a subsequent
    /// "offer" from them is trusted instead of dropped. Must be called before publishing
    /// an accepting pair-response, so the offer that follows finds this entry.
    pub fn authorize_peer(&self, node_id: &str, user_id: &str, display_name: &str) {
        self.authorized_peers.lock().insert(
            node_id.to_string(),
            PeerContext {
                user_id: user_id.to_string(),
                display_name: display_name.to_string(),
            },
        );
    }

    pub async fn connect(&self, broker_url: &str, node_id: &str) -> Result<(), String> {
        eprintln!("[Signaling] connect() broker_url={} node_id={}", broker_url, node_id);
        let client = MqttSignalingClient::new(broker_url, node_id).await?;

        // Only ever subscribe to our own node-scoped topics. Nothing broadcasts presence
        // and nothing is discoverable except by a device that already knows our node_id
        // out-of-band (QR/manual entry).
        for suffix in ["pair-request", "pair-response", "offer", "answer", "ice-candidate"] {
            client.subscribe(&format!("signaling/{}/{}", node_id, suffix)).await?;
        }
        eprintln!("[Signaling] Subscribed to node-scoped signaling topics for node_id={}", node_id);

        let (publish_tx, mut publish_rx) = mpsc::channel::<(String, Vec<u8>)>(100);
        let mqtt_client_clone = self.mqtt_client.clone();

        tokio::spawn(async move {
            while let Some((topic, payload)) = publish_rx.recv().await {
                let client_opt = mqtt_client_clone.lock().clone();
                if let Some(c) = client_opt {
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
        let authorized_peers = self.authorized_peers.clone();

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
                            if msg.to.as_deref() == Some(node_id_clone.as_str()) {
                                let uid = user_id_clone.lock().clone();
                                Self::handle_message(&app, msg, uid, authorized_peers.clone()).await;
                            } else {
                                eprintln!("[Signaling] Ignoring message not addressed to us (to: {:?})", msg.to);
                            }
                        }
                    }
                }
            });
        }

        Ok(())
    }

    async fn handle_message(
        app: &AppHandle,
        msg: SignalingMessage,
        our_user_id: String,
        authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
    ) {
        eprintln!("[Signaling] handle_message() type={} from={} our_user_id={}", msg.msg_type, msg.from, our_user_id);
        match msg.msg_type.as_str() {
            "pair-request" => {
                match serde_json::from_str::<PairPayload>(&msg.payload) {
                    Ok(req) => {
                        let _ = app.emit("mqtt-pair-request-received", serde_json::json!({
                            "from": msg.from,
                            "user_id": req.user_id,
                            "display_name": req.display_name,
                        }));
                    }
                    Err(e) => eprintln!("[Signaling] Failed to parse pair-request payload: {}", e),
                }
            }
            "pair-response" => {
                match serde_json::from_str::<PairPayload>(&msg.payload) {
                    Ok(resp) => {
                        let _ = app.emit("mqtt-pair-response-received", serde_json::json!({
                            "from": msg.from,
                            "user_id": resp.user_id,
                            "display_name": resp.display_name,
                            "accepted": resp.accepted.unwrap_or(false),
                        }));
                    }
                    Err(e) => eprintln!("[Signaling] Failed to parse pair-response payload: {}", e),
                }
            }
            "offer" => {
                Self::handle_offer(app, msg, our_user_id, authorized_peers).await;
            }
            "answer" => {
                eprintln!("[Signaling] Emitting mqtt-answer-received from={}", msg.from);
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
                });
                let _ = app.emit("mqtt-answer-received", payload);
            }
            "ice-candidate" => {
                eprintln!("[Signaling] Emitting mqtt-ice-candidate-received from={}", msg.from);
                let payload = serde_json::json!({
                    "from": msg.from,
                    "candidate": msg.payload,
                });
                let _ = app.emit("mqtt-ice-candidate-received", payload);
            }
            _ => {
                eprintln!("[Signaling] Unknown message type '{}', ignoring", msg.msg_type);
            }
        }
    }

    /// Resolves an incoming offer's sender against two trust sources, in order:
    /// 1. Already-persisted device_pairs (a previously completed pairing reconnecting,
    ///    e.g. after an app restart) - reuses the stored room_id directly.
    /// 2. In-memory authorized_peers (a pairing handshake accepted earlier this session)
    ///    - derives room_id from the two real user_ids exchanged during that handshake.
    /// If neither matches, the offer is from a node we never agreed to pair with and is
    /// dropped rather than auto-accepted.
    async fn handle_offer(
        app: &AppHandle,
        msg: SignalingMessage,
        our_user_id: String,
        authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
    ) {
        let persisted = {
            let state = app.state::<AppState>();
            let db = state.db.lock();
            pairing::get_pair_by_node_id(&db, &our_user_id, &msg.from).unwrap_or(None)
        };

        let (room_id, display_name) = if let Some(pair) = persisted {
            eprintln!("[Signaling] Offer from already-paired node {} (trusted reconnect)", msg.from);
            (pair.room_id, pair.peer_display_name)
        } else if let Some(ctx) = authorized_peers.lock().get(&msg.from).cloned() {
            eprintln!("[Signaling] Offer from session-authorized node {}", msg.from);
            (derive_room_id(&our_user_id, &ctx.user_id), ctx.display_name)
        } else {
            eprintln!("[Signaling] Rejecting unsolicited offer from unauthorized node {}", msg.from);
            return;
        };

        eprintln!("[Signaling] Emitting mqtt-offer-received from={} room_id={}", msg.from, room_id);
        let payload = serde_json::json!({
            "from": msg.from,
            "sdp": msg.payload,
            "room_id": room_id,
            "display_name": display_name,
        });
        let _ = app.emit("mqtt-offer-received", payload);
    }

    pub fn disconnect(&self) {
        eprintln!("[Signaling] disconnect() called, tearing down MQTT client");
        *self.mqtt_client.lock() = None;
        *self.publish_tx.lock() = None;
        self.authorized_peers.lock().clear();
    }

    pub fn is_connected(&self) -> bool {
        self.mqtt_client.lock().is_some()
    }

    async fn send_publish(&self, topic: String, payload: Vec<u8>) -> Result<(), String> {
        let tx_opt = self.publish_tx.lock().clone();
        match tx_opt {
            Some(tx) => tx.send((topic, payload)).await.map_err(|e| e.to_string()),
            None => Err("MQTT not connected".to_string()),
        }
    }

    pub async fn publish_pair_request(&self, peer_id: &str) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        let user_id = self.user_id.lock().clone();
        let display_name = self.display_name.lock().clone();
        eprintln!("[Signaling] publish_pair_request() to peer_id={}", peer_id);
        let payload = PairPayload { user_id, display_name, accepted: None };
        let msg = SignalingMessage {
            from: node_id,
            to: Some(peer_id.to_string()),
            msg_type: "pair-request".to_string(),
            payload: serde_json::to_string(&payload).map_err(|e| e.to_string())?,
        };
        let topic = format!("signaling/{}/pair-request", peer_id);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
    }

    pub async fn publish_pair_response(&self, peer_id: &str, accepted: bool) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        let user_id = self.user_id.lock().clone();
        let display_name = self.display_name.lock().clone();
        eprintln!("[Signaling] publish_pair_response() to peer_id={} accepted={}", peer_id, accepted);
        let payload = PairPayload { user_id, display_name, accepted: Some(accepted) };
        let msg = SignalingMessage {
            from: node_id,
            to: Some(peer_id.to_string()),
            msg_type: "pair-response".to_string(),
            payload: serde_json::to_string(&payload).map_err(|e| e.to_string())?,
        };
        let topic = format!("signaling/{}/pair-response", peer_id);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
    }

    pub async fn publish_offer(&self, peer_id: &str, sdp: &str) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        eprintln!("[Signaling] publish_offer() to peer_id={} from node_id={}", peer_id, node_id);
        let msg = SignalingMessage {
            from: node_id,
            to: Some(peer_id.to_string()),
            msg_type: "offer".to_string(),
            payload: sdp.to_string(),
        };
        let topic = format!("signaling/{}/offer", peer_id);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
    }

    pub async fn publish_answer(&self, peer_id: &str, sdp: &str) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        eprintln!("[Signaling] publish_answer() to peer_id={} from node_id={}", peer_id, node_id);
        let msg = SignalingMessage {
            from: node_id,
            to: Some(peer_id.to_string()),
            msg_type: "answer".to_string(),
            payload: sdp.to_string(),
        };
        let topic = format!("signaling/{}/answer", peer_id);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
    }

    pub async fn publish_ice_candidate(&self, peer_id: &str, candidate: &str) -> Result<(), String> {
        let node_id = self.node_id.lock().clone();
        eprintln!("[Signaling] publish_ice_candidate() to peer_id={} from node_id={}", peer_id, node_id);
        let msg = SignalingMessage {
            from: node_id,
            to: Some(peer_id.to_string()),
            msg_type: "ice-candidate".to_string(),
            payload: candidate.to_string(),
        };
        let topic = format!("signaling/{}/ice-candidate", peer_id);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
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
