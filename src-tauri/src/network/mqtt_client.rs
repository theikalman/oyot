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
        let mut mqtt_options = rumqttc::MqttOptions::new(node_id, broker_url, 1883);
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