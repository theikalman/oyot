use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// A signaling message as it travels over MQTT.
///
/// `from` is the sender's Ed25519 public key and `sig` covers every other
/// field, so the broker relays messages it cannot forge or alter. `ts` and
/// `nonce` make each one fresh and single-use. See crate::crypto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalingMessage {
    pub from: String,
    pub to: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: String,
    pub ts: i64,
    pub nonce: String,
    pub sig: String,
}

#[derive(Debug, Clone)]
pub enum MqttEvent {
    Connected,
    Disconnected,
    /// The client has never had a session up and the last attempt failed, so
    /// the address, the TLS setup or the credentials are wrong and retrying
    /// will not help. Emitted once per run of failures, not once per retry:
    /// without it a bad broker URL left the UI on "connecting" indefinitely
    /// while the loop backed off silently to 30s.
    Error(String),
    Message {
        topic: String,
        msg: SignalingMessage,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct BrokerUrl {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

/// Parse a broker URL into host, port and whether to use TLS.
///
/// The previous version tested `starts_with("mqtt://")`, which does not match
/// `mqtts://`. A TLS URL therefore fell through to the bare `host:port` branch
/// and produced the host `"mqtts://broker.example"`, which failed DNS with an
/// error that said nothing about the real problem. An unrecognised scheme is
/// now a clear error rather than a mangled host.
pub fn parse_broker_url(url: &str) -> Result<BrokerUrl, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Broker URL is empty".to_string());
    }

    let (rest, tls, default_port) = if let Some(r) = url.strip_prefix("mqtts://") {
        (r, true, 8883)
    } else if let Some(r) = url.strip_prefix("ssl://") {
        (r, true, 8883)
    } else if let Some(r) = url.strip_prefix("mqtt://") {
        (r, false, 1883)
    } else if let Some(r) = url.strip_prefix("tcp://") {
        (r, false, 1883)
    } else if let Some(idx) = url.find("://") {
        return Err(format!(
            "Unsupported broker scheme '{}'. Use mqtt:// or mqtts://",
            &url[..idx]
        ));
    } else {
        (url, false, 1883)
    };

    let rest = rest.trim_end_matches('/');
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p
                .parse()
                .map_err(|_| format!("Invalid broker port '{p}'"))?;
            (h, port)
        }
        None => (rest, default_port),
    };

    if host.is_empty() {
        return Err("Broker URL has no host".to_string());
    }

    Ok(BrokerUrl {
        host: host.to_string(),
        port,
        tls,
    })
}

/// A rustls config trusting the platform root store.
///
/// Built explicitly rather than via `TlsConfiguration::default()`, which
/// `expect()`s on the cert load and `unwrap()`s on every certificate. A device
/// with an unreadable trust store should fail to connect with a message, not
/// panic inside the command that the frontend awaits.
fn tls_configuration() -> Result<rumqttc::TlsConfiguration, String> {
    let mut roots = rustls::RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs()
        .map_err(|e| format!("Could not load the platform certificate store: {e}"))?;
    let mut added = 0usize;
    for cert in certs {
        // Individual malformed certs in a platform store are not fatal; an
        // empty result is.
        if roots.add(cert).is_ok() {
            added += 1;
        }
    }
    if added == 0 {
        return Err("The platform certificate store has no usable certificates".to_string());
    }

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(rumqttc::TlsConfiguration::Rustls(std::sync::Arc::new(
        config,
    )))
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
    pub async fn new(
        broker_url: &str,
        node_id: &str,
        credentials: Option<(String, String)>,
    ) -> Result<Self, String> {
        let url = broker_url.trim();
        let BrokerUrl { host, port, tls } = parse_broker_url(url)?;

        trace!(
            "[MQTT] Connecting to broker host={} port={} tls={} client_id={}",
            host,
            port,
            tls,
            node_id
        );

        let mut mqtt_options = rumqttc::MqttOptions::new(node_id, &host, port);
        mqtt_options.set_keep_alive(std::time::Duration::from_secs(30));
        if let Some((username, password)) = credentials {
            // A broker that requires authentication rejected every connection
            // before this, and the reference configuration in the repository
            // was one, so following the documentation produced a broker the
            // app could not use.
            mqtt_options.set_credentials(username, password);
        }
        if tls {
            // Signaling is signed end to end, so TLS is not what makes a
            // message trustworthy. It is what stops the broker operator, or
            // anyone on the path, reading who is pairing with whom and
            // harvesting SDP.
            mqtt_options.set_transport(rumqttc::Transport::Tls(tls_configuration()?));
        }

        let (client, event_loop) = rumqttc::AsyncClient::new(mqtt_options, 100);
        // Generous, because overflowing this channel costs dropped signaling.
        // A burst is cheap to hold and the messages are small.
        let (event_tx, _) = broadcast::channel(1024);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        // Only ever subscribe to our own node-scoped topics. Nothing broadcasts
        // presence and nothing is discoverable except by a device that already
        // knows our node_id out-of-band (QR/manual entry).
        let topics: Vec<String> = [
            "pair-request",
            "pair-response",
            "offer",
            "answer",
            "ice-candidate",
        ]
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
            // Whether a session has ever come up on this client, and whether
            // we have already reported the current run of failures. Together
            // they separate "cannot connect at all" from "was connected and
            // dropped", and keep the first from firing on every retry.
            let mut ever_connected = false;
            let mut reported_failure = false;

            loop {
                tokio::select! {
                    // `changed()` resolves on send (we only ever send `true`) or when the
                    // sender is dropped - both mean this client generation is done.
                    _ = shutdown_rx.changed() => {
                        trace!("[MQTT] shutdown signalled, event loop exiting");
                        let _ = client_clone.disconnect().await;
                        break;
                    }
                    res = event_loop.poll() => match res {
                        Ok(notification) => {
                            backoff = RECONNECT_BACKOFF_START;
                            match notification {
                                rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(ack)) => {
                                    trace!("[MQTT] ConnAck received: {:?}", ack);
                                    for topic in topics.iter() {
                                        match client_clone.subscribe(topic, rumqttc::QoS::AtLeastOnce).await {
                                            Ok(()) => trace!("[MQTT] (re)subscribed to '{}'", topic),
                                            Err(e) => warn_log!("[MQTT] Failed to (re)subscribe to '{}': {}", topic, e),
                                        }
                                    }
                                    connected_clone.store(true, Ordering::Relaxed);
                                    ever_connected = true;
                                    reported_failure = false;
                                    let _ = event_tx_clone.send(MqttEvent::Connected);
                                }
                                rumqttc::Event::Incoming(rumqttc::Packet::SubAck(ack)) => {
                                    trace!("[MQTT] SubAck received: {:?}", ack);
                                }
                                rumqttc::Event::Incoming(rumqttc::Packet::Publish(publish)) => {
                                    trace!("[MQTT] Raw publish received on topic '{}' ({} bytes)", publish.topic, publish.payload.len());
                                    if let Ok(msg) = serde_json::from_slice::<SignalingMessage>(&publish.payload) {
                                        trace!("[MQTT] Parsed signaling message: type={} from={} to={:?}", msg.msg_type, msg.from, msg.to);
                                        let _ = event_tx_clone.send(MqttEvent::Message {
                                            topic: publish.topic,
                                            msg,
                                        });
                                    } else {
                                        warn_log!("[MQTT] Failed to parse publish payload on topic '{}' as SignalingMessage", publish.topic);
                                    }
                                }
                                rumqttc::Event::Outgoing(rumqttc::Outgoing::Publish(_)) => {
                                    trace!("[MQTT] Outgoing publish acknowledged by client");
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            warn_log!("[MQTT] Connection error: {}; retrying in {:?}", e, backoff);
                            // Emit Disconnected only on a healthy -> broken transition so a
                            // long outage doesn't spam the frontend with status events.
                            if connected_clone.swap(false, Ordering::Relaxed) {
                                let _ = event_tx_clone.send(MqttEvent::Disconnected);
                            } else if !ever_connected && !reported_failure {
                                // Never got a session up. `new()` returns before
                                // a single packet is exchanged, so this is the
                                // only place a wrong host, a refused TLS
                                // handshake or a rejected login can be reported.
                                reported_failure = true;
                                let _ = event_tx_clone.send(MqttEvent::Error(e.to_string()));
                            }
                            tokio::select! {
                                _ = tokio::time::sleep(backoff) => {}
                                _ = shutdown_rx.changed() => {
                                    trace!("[MQTT] shutdown signalled during backoff, event loop exiting");
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
        trace!(
            "[MQTT] Publishing {} bytes to topic '{}'",
            payload.len(),
            topic
        );
        let result = self
            .client
            .publish(topic, rumqttc::QoS::AtLeastOnce, false, payload)
            .await
            .map_err(|e| e.to_string());
        if let Err(e) = &result {
            warn_log!("[MQTT] Failed to publish to '{}': {}", topic, e);
        }
        result
    }

    pub fn subscribe_to_events(&self) -> broadcast::Receiver<MqttEvent> {
        self.event_tx.subscribe()
    }

    /// Stops the reconnect/poll loop for this client generation. Idempotent.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(url: &str) -> BrokerUrl {
        parse_broker_url(url).unwrap_or_else(|e| panic!("{url} should parse: {e}"))
    }

    #[test]
    fn plain_schemes_default_to_1883() {
        for url in [
            "mqtt://broker.example",
            "tcp://broker.example",
            "broker.example",
        ] {
            let parsed = ok(url);
            assert_eq!(parsed.host, "broker.example");
            assert_eq!(parsed.port, 1883);
            assert!(!parsed.tls, "{url} should not be TLS");
        }
    }

    // The regression: `starts_with("mqtt://")` does not match `mqtts://`, so a
    // TLS URL fell through to the bare host:port branch and produced the host
    // "mqtts://broker.example", which failed DNS with an unrelated-looking error.
    #[test]
    fn tls_schemes_are_recognised_and_default_to_8883() {
        for url in ["mqtts://broker.example", "ssl://broker.example"] {
            let parsed = ok(url);
            assert_eq!(
                parsed.host, "broker.example",
                "{url} produced a mangled host"
            );
            assert_eq!(parsed.port, 8883);
            assert!(parsed.tls, "{url} should be TLS");
        }
    }

    #[test]
    fn an_explicit_port_overrides_the_default() {
        assert_eq!(ok("mqtt://broker.example:1884").port, 1884);
        assert_eq!(ok("mqtts://broker.example:9001").port, 9001);
        assert_eq!(ok("broker.example:1885").port, 1885);
    }

    #[test]
    fn a_trailing_slash_is_not_part_of_the_host() {
        let parsed = ok("mqtts://broker.example/");
        assert_eq!(parsed.host, "broker.example");
        assert_eq!(parsed.port, 8883);
    }

    #[test]
    fn an_unknown_scheme_is_an_error_not_a_mangled_host() {
        let err = parse_broker_url("https://broker.example").unwrap_err();
        assert!(err.contains("Unsupported broker scheme"), "got: {err}");
        assert!(
            err.contains("https"),
            "the error should name the scheme: {err}"
        );
    }

    #[test]
    fn malformed_urls_are_rejected() {
        for url in ["", "   ", "mqtt://", "mqtt://broker.example:notaport"] {
            assert!(parse_broker_url(url).is_err(), "{url:?} should be rejected");
        }
    }

    #[test]
    fn whitespace_around_the_url_is_ignored() {
        assert_eq!(ok("  mqtts://broker.example:8884  ").port, 8884);
    }
}
