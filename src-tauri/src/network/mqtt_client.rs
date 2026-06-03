use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

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

pub struct MqttSignalingClient {
    client: rumqttc::AsyncClient,
    event_tx: broadcast::Sender<MqttEvent>,
}

impl Clone for MqttSignalingClient {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            event_tx: self.event_tx.clone(),
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

        let mut mqtt_options = rumqttc::MqttOptions::new(node_id, &host, port);
        mqtt_options.set_keep_alive(std::time::Duration::from_secs(30));

        let (client, event_loop) = rumqttc::AsyncClient::new(mqtt_options, 100);
        let (event_tx, _) = broadcast::channel(100);
        let event_tx_clone = event_tx.clone();

        tokio::spawn(async move {
            let mut event_loop = event_loop;
            loop {
                match event_loop.poll().await {
                    Ok(notification) => {
                        match notification {
                            rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(_)) => {
                                let _ = event_tx_clone.send(MqttEvent::Connected);
                            }
                            rumqttc::Event::Incoming(rumqttc::Packet::Publish(publish)) => {
                                if let Ok(msg) = serde_json::from_slice::<SignalingMessage>(&publish.payload) {
                                    let _ = event_tx_clone.send(MqttEvent::Message {
                                        topic: publish.topic,
                                        msg,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        eprintln!("MQTT connection error: {}", e);
                        let _ = event_tx_clone.send(MqttEvent::Disconnected);
                        break;
                    }
                }
            }
        });

        Ok(Self { client, event_tx })
    }

    pub async fn subscribe(&self, topic: &str) -> Result<(), String> {
        self.client.subscribe(topic, rumqttc::QoS::AtLeastOnce)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn publish(&self, topic: &str, payload: &[u8]) -> Result<(), String> {
        self.client.publish(topic, rumqttc::QoS::AtLeastOnce, false, payload)
            .await
            .map_err(|e| e.to_string())
    }

    pub fn subscribe_to_events(&self) -> broadcast::Receiver<MqttEvent> {
        self.event_tx.subscribe()
    }
}