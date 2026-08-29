use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalingMessage {
    pub from: String,
    pub to: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: String,
}

#[derive(Debug, Clone)]
pub enum MqttEvent {
    Connected,
    Disconnected,
    Message { topic: String, msg: SignalingMessage },
}

/// Backoff bounds for the reconnect loop. rumqttc's event loop reconnects on the
/// next `poll()` after an error; the sleep here just prevents a hot error loop
/// (rumqttc 0.24 has no built-in delay).
const RECONNECT_BACKOFF_START: Duration = Duration::from_secs(1);
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(30);

pub struct MqttSignalingClient {
    client: rumqttc::AsyncClient,
    event_tx: broadcast::Sender<MqttEvent>,
    /// True only while an MQTT session is live (set on ConnAck, cleared on error).
    connected: Arc<AtomicBool>,
    /// Set to `true` to make the poll loop exit (on `disconnect()` or when a new
    /// client generation replaces this one).
    shutdown_tx: watch::Sender<bool>,
}

impl Clone for MqttSignalingClient {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            event_tx: self.event_tx.clone(),
            connected: self.connected.clone(),
            shutdown_tx: self.shutdown_tx.clone(),
        }
    }
}

impl MqttSignalingClient {
    pub async fn new(broker_url: &str, node_id: &str) -> Result<Self, String> {
        let url = broker_url.trim();
        if url.is_empty() {
            return Err("Broker URL is empty".to_string());
        }

        let (host, port) = if url.starts_with("mqtt://") || url.starts_with("tcp://") {
            let without_scheme = url.trim_start_matches("mqtt://").trim_start_matches("tcp://");
            let parts: Vec<&str> = without_scheme.split(':').collect();
            let host = parts[0].to_string();
            let port = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(1883);
            (host, port)
        } else if let Some(port_idx) = url.rfind(':') {
            let host = url[..port_idx].to_string();
            let port = url[port_idx + 1..].parse().unwrap_or(1883);
            (host, port)
        } else {
            (url.to_string(), 1883)
        };

        eprintln!("[MQTT] Connecting to broker host={} port={} client_id={}", host, port, node_id);

        let mut mqtt_options = rumqttc::MqttOptions::new(node_id, &host, port);
        mqtt_options.set_keep_alive(std::time::Duration::from_secs(30));

        let (client, event_loop) = rumqttc::AsyncClient::new(mqtt_options, 100);
        let (event_tx, _) = broadcast::channel(100);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        // Only ever subscribe to our own node-scoped topics. Nothing broadcasts
        // presence and nothing is discoverable except by a device that already
        // knows our node_id out-of-band (QR/manual entry).
        let topics: Vec<String> =
            ["pair-request", "pair-response", "offer", "answer", "ice-candidate"]
                .iter()
                .map(|suffix| format!("signaling/{}/{}", node_id, suffix))
                .collect();

        let connected = Arc::new(AtomicBool::new(false));

        let event_tx_clone = event_tx.clone();
        let client_clone = client.clone();
        let connected_clone = connected.clone();

        tokio::spawn(async move {
            let mut event_loop = event_loop;
            let mut shutdown_rx = shutdown_rx;
            let mut backoff = RECONNECT_BACKOFF_START;

            loop {
                tokio::select! {
                    // `changed()` resolves on send (we only ever send `true`) or when the
                    // sender is dropped - both mean this client generation is done.
                    _ = shutdown_rx.changed() => {
                        eprintln!("[MQTT] shutdown signalled, event loop exiting");
                        let _ = client_clone.disconnect().await;
                        break;
                    }
                    res = event_loop.poll() => match res {
                        Ok(notification) => {
                            backoff = RECONNECT_BACKOFF_START;
                            match notification {
                                rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(ack)) => {
                                    eprintln!("[MQTT] ConnAck received: {:?}", ack);
                                    for topic in topics.iter() {
                                        match client_clone.subscribe(topic, rumqttc::QoS::AtLeastOnce).await {
                                            Ok(()) => eprintln!("[MQTT] (re)subscribed to '{}'", topic),
                                            Err(e) => eprintln!("[MQTT] Failed to (re)subscribe to '{}': {}", topic, e),
                                        }
                                    }
                                    connected_clone.store(true, Ordering::Relaxed);
                                    let _ = event_tx_clone.send(MqttEvent::Connected);
                                }
                                rumqttc::Event::Incoming(rumqttc::Packet::SubAck(ack)) => {
                                    eprintln!("[MQTT] SubAck received: {:?}", ack);
                                }
                                rumqttc::Event::Incoming(rumqttc::Packet::Publish(publish)) => {
                                    eprintln!("[MQTT] Raw publish received on topic '{}' ({} bytes)", publish.topic, publish.payload.len());
                                    if let Ok(msg) = serde_json::from_slice::<SignalingMessage>(&publish.payload) {
                                        eprintln!("[MQTT] Parsed signaling message: type={} from={} to={:?}", msg.msg_type, msg.from, msg.to);
                                        let _ = event_tx_clone.send(MqttEvent::Message {
                                            topic: publish.topic,
                                            msg,
                                        });
                                    } else {
                                        eprintln!("[MQTT] Failed to parse publish payload on topic '{}' as SignalingMessage", publish.topic);
                                    }
                                }
                                rumqttc::Event::Outgoing(rumqttc::Outgoing::Publish(_)) => {
                                    eprintln!("[MQTT] Outgoing publish acknowledged by client");
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            eprintln!("[MQTT] Connection error: {}; retrying in {:?}", e, backoff);
                            // Emit Disconnected only on a healthy -> broken transition so a
                            // long outage doesn't spam the frontend with status events.
                            if connected_clone.swap(false, Ordering::Relaxed) {
                                let _ = event_tx_clone.send(MqttEvent::Disconnected);
                            }
                            tokio::select! {
                                _ = tokio::time::sleep(backoff) => {}
                                _ = shutdown_rx.changed() => {
                                    eprintln!("[MQTT] shutdown signalled during backoff, event loop exiting");
                                    break;
                                }
                            }
                            backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX);
                            // Do not break - the next poll() drives rumqttc's own reconnect.
                        }
                    }
                }
            }

            connected_clone.store(false, Ordering::Relaxed);
        });

        Ok(Self {
            client,
            event_tx,
            connected,
            shutdown_tx,
        })
    }

    pub async fn publish(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
        eprintln!("[MQTT] Publishing {} bytes to topic '{}'", payload.len(), topic);
        let result = self.client.publish(topic, rumqttc::QoS::AtLeastOnce, false, payload)
            .await
            .map_err(|e| e.to_string());
        if let Err(e) = &result {
            eprintln!("[MQTT] Failed to publish to '{}': {}", topic, e);
        }
        result
    }

    pub fn subscribe_to_events(&self) -> broadcast::Receiver<MqttEvent> {
        self.event_tx.subscribe()
    }

    /// True while an MQTT session is live (post-ConnAck). False while connecting,
    /// reconnecting, or after shutdown.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Stops the reconnect/poll loop for this client generation. Idempotent.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}
