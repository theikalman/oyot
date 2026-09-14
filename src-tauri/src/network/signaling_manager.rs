use crate::crypto::{self, EnvelopeVerifier};
use crate::db::AppState;
use crate::identity::LocalIdentity;
use crate::network::mqtt_client::{MqttEvent, MqttSignalingClient, SignalingMessage};
use crate::pairing;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, mpsc};

// Topic plus payload, handed to the publish task that owns the live MQTT client.
type PublishSender = mpsc::Sender<(String, Vec<u8>)>;

/// How often one sender may raise a pairing prompt.
///
/// A signature proves who sent a request, not that we want it. Anyone who
/// learns a node_id can publish to its topic, and every valid request put a
/// modal in front of the user, so an unpaired device could make the app
/// unusable by asking repeatedly. Declining is still the answer to a request
/// you did not expect; this only stops it being asked faster than a person
/// can read it.
const PAIR_REQUEST_COOLDOWN_MS: i64 = 30_000;

/// Distinct senders whose last request time we remember. Bounded, or asking
/// from many keys would grow it; the oldest entry is dropped, which at worst
/// lets that sender ask once more.
const MAX_PAIR_REQUEST_SENDERS: usize = 64;

/// Whether a pairing prompt from `from` should be shown, given when that
/// sender last raised one. Records the time when it allows.
fn allow_pair_prompt(seen: &mut Vec<(String, i64)>, from: &str, now: i64) -> bool {
    if let Some(entry) = seen.iter_mut().find(|(id, _)| id == from) {
        if now - entry.1 < PAIR_REQUEST_COOLDOWN_MS {
            return false;
        }
        entry.1 = now;
        return true;
    }
    if seen.len() >= MAX_PAIR_REQUEST_SENDERS {
        seen.remove(0);
    }
    seen.push((from.to_string(), now));
    true
}

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
    /// This device's identity and signing key. Every outgoing message is signed
    /// with it, and `node_id` is the public half peers verify against.
    identity: Arc<ParkingMutex<Option<LocalIdentity>>>,
    app_handle: Option<AppHandle>,
    publish_tx: Arc<ParkingMutex<Option<PublishSender>>>,
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
            identity: Arc::new(ParkingMutex::new(None)),
            app_handle,
            publish_tx: Arc::new(ParkingMutex::new(None)),
            authorized_peers: Arc::new(ParkingMutex::new(HashMap::new())),
        }
    }

    /// The public half of the loaded identity, or `None` before startup has
    /// set it. Deliberately not the whole `LocalIdentity`: callers outside
    /// this module have no business holding the signing key, and not making
    /// it cloneable is what keeps that true.
    pub fn public_identity(&self) -> Option<crate::identity::UserIdentity> {
        self.identity.lock().as_ref().map(|i| i.public.clone())
    }

    /// Keep the in-memory copy in step with a rename, so the next pair request
    /// advertises the new name rather than the one loaded at startup.
    pub fn set_display_name(&self, display_name: &str) {
        if let Some(identity) = self.identity.lock().as_mut() {
            identity.public.display_name = display_name.to_string();
        }
    }

    pub fn set_identity(&self, identity: LocalIdentity) {
        *self.identity.lock() = Some(identity);
    }

    pub fn get_node_id(&self) -> String {
        self.identity
            .lock()
            .as_ref()
            .map(|i| i.public.node_id.clone())
            .unwrap_or_default()
    }

    fn get_user_id(&self) -> String {
        self.identity
            .lock()
            .as_ref()
            .map(|i| i.public.user_id.clone())
            .unwrap_or_default()
    }

    fn get_display_name(&self) -> String {
        self.identity
            .lock()
            .as_ref()
            .map(|i| i.public.display_name.clone())
            .unwrap_or_default()
    }

    /// Wraps a message in a signed envelope. Fails when no identity is loaded,
    /// which would otherwise mean publishing something no peer can verify.
    fn seal(&self, to: &str, msg_type: &str, payload: String) -> Result<SignalingMessage, String> {
        let guard = self.identity.lock();
        let me = guard
            .as_ref()
            .ok_or_else(|| "cannot sign: identity not loaded".to_string())?;

        let from = me.public.node_id.clone();
        let ts = crypto::now_ms();
        let nonce = crypto::random_nonce();
        let sig = crypto::sign(&me.signing_key, &from, to, msg_type, &payload, ts, &nonce);

        Ok(SignalingMessage {
            from,
            to: Some(to.to_string()),
            msg_type: msg_type.to_string(),
            payload,
            ts,
            nonce,
            sig,
        })
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

    /// Forget a session authorization.
    ///
    /// `authorize_peer` vouches for a node for the rest of the session, and
    /// `handle_offer` accepts an offer on the strength of either that or a
    /// persisted pairing. Removing a pair only deleted the row, so the
    /// in-memory entry kept vouching: the removed device's next offer was
    /// accepted, the frontend connected and then re-saved the very pair the
    /// user had just removed.
    pub fn revoke_peer(&self, node_id: &str) {
        if self.authorized_peers.lock().remove(node_id).is_some() {
            trace!("[Signaling] revoked session authorization for {}", node_id);
        }
    }

    pub async fn connect(
        &self,
        broker_url: &str,
        node_id: &str,
        credentials: Option<(String, String)>,
    ) -> Result<(), String> {
        trace!(
            "[Signaling] connect() broker_url={} node_id={}",
            broker_url,
            node_id
        );

        // Tear down any previous client generation so its reconnect loop and publish
        // task stop instead of racing the new one.
        if let Some(old) = self.mqtt_client.lock().take() {
            trace!("[Signaling] Shutting down previous MQTT client generation");
            old.shutdown();
        }

        let client = MqttSignalingClient::new(broker_url, node_id, credentials).await?;
        // Topic subscription now happens inside the client's poll loop on every
        // ConnAck, so it is replayed automatically after a reconnect.

        if let Some(app_handle) = &self.app_handle {
            let _ = app_handle.emit("mqtt-status", "connecting");
        }

        let (publish_tx, mut publish_rx) = mpsc::channel::<(String, Vec<u8>)>(100);
        let mqtt_client_clone = self.mqtt_client.clone();

        tokio::spawn(async move {
            while let Some((topic, payload)) = publish_rx.recv().await {
                let client_opt = mqtt_client_clone.lock().clone();
                if let Some(c) = client_opt {
                    if let Err(e) = c.publish(&topic, &payload).await {
                        warn_log!("MQTT publish error: {}", e);
                    }
                }
            }
        });

        *self.publish_tx.lock() = Some(publish_tx);

        let mut event_rx = client.subscribe_to_events();
        *self.mqtt_client.lock() = Some(client);

        let our_user_id = self.get_user_id();
        let node_id_str = node_id.to_string();
        let authorized_peers = self.authorized_peers.clone();

        if let Some(app_handle) = &self.app_handle {
            let app = app_handle.clone();
            let node_id_clone = node_id_str.clone();
            // One verifier per client generation, so its replay history spans
            // the whole session rather than a single message.
            let mut verifier = EnvelopeVerifier::new();
            // Owned by this task, like the verifier, so it spans the session
            // rather than a single message.
            let mut pair_prompts: Vec<(String, i64)> = Vec::new();
            tokio::spawn(async move {
                loop {
                    let event = match event_rx.recv().await {
                        Ok(event) => event,
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            // Keep going. Breaking here stopped every signaling
                            // message reaching the frontend for the rest of the
                            // session, while MQTT went on reporting "connected"
                            // and nothing recovered short of a manual
                            // reconnect. Anyone able to publish to the broker
                            // could cause it, since a message is parsed and
                            // queued before its signature is checked.
                            warn_log!(
                                "[Signaling] event channel lagged, {} message(s) dropped",
                                skipped
                            );
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            trace!("[Signaling] event channel closed, forwarder exiting");
                            break;
                        }
                    };
                    match event {
                        MqttEvent::Connected => {
                            trace!("[Signaling] MQTT Connected");
                            let _ = app.emit("mqtt-status", "connected");
                        }
                        MqttEvent::Disconnected => {
                            let _ = app.emit("mqtt-status", "disconnected");
                        }
                        MqttEvent::Error(reason) => {
                            warn_log!("[Signaling] MQTT could not connect: {}", reason);
                            let _ = app.emit("mqtt-status", "error");
                            let _ = app.emit("mqtt-error", reason);
                        }
                        MqttEvent::Message { topic, msg } => {
                            trace!(
                                "[Signaling] Received MQTT message on topic '{}': {:?}",
                                topic,
                                msg.msg_type
                            );
                            if msg.to.as_deref() != Some(node_id_clone.as_str()) {
                                trace!(
                                    "[Signaling] Ignoring message not addressed to us (to: {:?})",
                                    msg.to
                                );
                                continue;
                            }

                            // Before anything reads the payload: prove the
                            // sender holds the secret key for the node_id it
                            // claims, that the message is fresh, and that we
                            // have not already processed it. The broker is
                            // untrusted; anyone able to publish can set `from`
                            // to whatever they like.
                            if let Err(e) = verifier.verify(
                                &msg.from,
                                node_id_clone.as_str(),
                                &msg.msg_type,
                                &msg.payload,
                                msg.ts,
                                &msg.nonce,
                                &msg.sig,
                                crypto::now_ms(),
                            ) {
                                warn_log!(
                                    "[Signaling] Rejecting {} from {}: {}",
                                    msg.msg_type,
                                    msg.from,
                                    e
                                );
                                continue;
                            }

                            Self::handle_message(
                                &app,
                                msg,
                                our_user_id.clone(),
                                authorized_peers.clone(),
                                &mut pair_prompts,
                            )
                            .await;
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
        pair_prompts: &mut Vec<(String, i64)>,
    ) {
        trace!(
            "[Signaling] handle_message() type={} from={} our_user_id={}",
            msg.msg_type,
            msg.from,
            our_user_id
        );
        match msg.msg_type.as_str() {
            "pair-request" => match serde_json::from_str::<PairPayload>(&msg.payload) {
                Ok(req) => {
                    if !allow_pair_prompt(pair_prompts, &msg.from, crypto::now_ms()) {
                        warn_log!(
                            "[Signaling] Ignoring a repeat pair-request from {} inside the cooldown",
                            msg.from
                        );
                        return;
                    }
                    let _ = app.emit(
                        "mqtt-pair-request-received",
                        serde_json::json!({
                            "from": msg.from,
                            "user_id": req.user_id,
                            "display_name": req.display_name,
                        }),
                    );
                }
                Err(e) => warn_log!("[Signaling] Failed to parse pair-request payload: {}", e),
            },
            "pair-response" => match serde_json::from_str::<PairPayload>(&msg.payload) {
                Ok(resp) => {
                    let _ = app.emit(
                        "mqtt-pair-response-received",
                        serde_json::json!({
                            "from": msg.from,
                            "user_id": resp.user_id,
                            "display_name": resp.display_name,
                            "accepted": resp.accepted.unwrap_or(false),
                        }),
                    );
                }
                Err(e) => warn_log!("[Signaling] Failed to parse pair-response payload: {}", e),
            },
            "offer" => {
                Self::handle_offer(app, msg, our_user_id, authorized_peers).await;
            }
            "answer" => {
                trace!(
                    "[Signaling] Emitting mqtt-answer-received from={}",
                    msg.from
                );
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
                });
                let _ = app.emit("mqtt-answer-received", payload);
            }
            "ice-candidate" => {
                trace!(
                    "[Signaling] Emitting mqtt-ice-candidate-received from={}",
                    msg.from
                );
                let payload = serde_json::json!({
                    "from": msg.from,
                    "candidate": msg.payload,
                });
                let _ = app.emit("mqtt-ice-candidate-received", payload);
            }
            _ => {
                warn_log!(
                    "[Signaling] Unknown message type '{}', ignoring",
                    msg.msg_type
                );
            }
        }
    }

    /// Resolves an incoming offer's sender against two trust sources, in order:
    /// 1. Already-persisted device_pairs (a previously completed pairing reconnecting,
    ///    e.g. after an app restart) - reuses the stored room_id directly.
    /// 2. In-memory authorized_peers (a pairing handshake accepted earlier this session)
    ///    - derives room_id from the two real user_ids exchanged during that handshake.
    ///
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
            trace!(
                "[Signaling] Offer from already-paired node {} (trusted reconnect)",
                msg.from
            );
            (pair.room_id, pair.peer_display_name)
        } else if let Some(ctx) = authorized_peers.lock().get(&msg.from).cloned() {
            trace!(
                "[Signaling] Offer from session-authorized node {}",
                msg.from
            );
            (
                pairing::derive_room_id(&our_user_id, &ctx.user_id),
                ctx.display_name,
            )
        } else {
            warn_log!(
                "[Signaling] Rejecting unsolicited offer from unauthorized node {}",
                msg.from
            );
            return;
        };

        trace!(
            "[Signaling] Emitting mqtt-offer-received from={} room_id={}",
            msg.from,
            room_id
        );
        let payload = serde_json::json!({
            "from": msg.from,
            "sdp": msg.payload,
            "room_id": room_id,
            "display_name": display_name,
        });
        let _ = app.emit("mqtt-offer-received", payload);
    }

    async fn send_publish(&self, topic: String, payload: Vec<u8>) -> Result<(), String> {
        let tx_opt = self.publish_tx.lock().clone();
        match tx_opt {
            Some(tx) => tx.send((topic, payload)).await.map_err(|e| e.to_string()),
            None => Err("MQTT not connected".to_string()),
        }
    }

    /// Publish one signed message to a peer's node-scoped topic.
    ///
    /// Every outgoing message goes through here, so there is no path that
    /// publishes an unsigned envelope.
    async fn publish(&self, peer_id: &str, msg_type: &str, payload: String) -> Result<(), String> {
        trace!("[Signaling] publish {} to peer_id={}", msg_type, peer_id);
        let msg = self.seal(peer_id, msg_type, payload)?;
        let topic = format!("signaling/{}/{}", peer_id, msg_type);
        let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
        self.send_publish(topic, bytes).await
    }

    fn pair_payload(&self, accepted: Option<bool>) -> Result<String, String> {
        let payload = PairPayload {
            user_id: self.get_user_id(),
            display_name: self.get_display_name(),
            accepted,
        };
        serde_json::to_string(&payload).map_err(|e| e.to_string())
    }

    pub async fn publish_pair_request(&self, peer_id: &str) -> Result<(), String> {
        let payload = self.pair_payload(None)?;
        self.publish(peer_id, "pair-request", payload).await
    }

    pub async fn publish_pair_response(&self, peer_id: &str, accepted: bool) -> Result<(), String> {
        let payload = self.pair_payload(Some(accepted))?;
        self.publish(peer_id, "pair-response", payload).await
    }

    pub async fn publish_offer(&self, peer_id: &str, sdp: &str) -> Result<(), String> {
        self.publish(peer_id, "offer", sdp.to_string()).await
    }

    pub async fn publish_answer(&self, peer_id: &str, sdp: &str) -> Result<(), String> {
        self.publish(peer_id, "answer", sdp.to_string()).await
    }

    pub async fn publish_ice_candidate(
        &self,
        peer_id: &str,
        candidate: &str,
    ) -> Result<(), String> {
        self.publish(peer_id, "ice-candidate", candidate.to_string())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::EnvelopeVerifier;
    use crate::identity::{LocalIdentity, UserIdentity};

    fn manager_with_identity() -> (SignalingManager, String) {
        let signing_key = crypto::generate_signing_key();
        let node_id = crypto::encode_node_id(&signing_key.verifying_key());
        let mgr = SignalingManager::new(None);
        mgr.set_identity(LocalIdentity {
            public: UserIdentity {
                user_id: "u1".to_string(),
                node_id: node_id.clone(),
                display_name: "Laptop".to_string(),
            },
            signing_key,
        });
        (mgr, node_id)
    }

    // The unit tests in crypto cover the primitives; this covers the wiring,
    // i.e. that what seal() produces is what a peer's verifier accepts.
    #[test]
    fn a_repeat_pair_request_inside_the_cooldown_is_dropped() {
        // Every valid request put a modal in front of the user, so anyone who
        // learned a node_id could make the app unusable by asking repeatedly.
        let mut seen = Vec::new();
        let now = 1_000_000;

        assert!(allow_pair_prompt(&mut seen, "peer-a", now));
        assert!(!allow_pair_prompt(&mut seen, "peer-a", now + 1));
        assert!(!allow_pair_prompt(
            &mut seen,
            "peer-a",
            now + PAIR_REQUEST_COOLDOWN_MS - 1
        ));
        assert!(allow_pair_prompt(
            &mut seen,
            "peer-a",
            now + PAIR_REQUEST_COOLDOWN_MS
        ));
    }

    #[test]
    fn one_sender_in_cooldown_does_not_silence_another() {
        let mut seen = Vec::new();
        let now = 1_000_000;

        assert!(allow_pair_prompt(&mut seen, "peer-a", now));
        assert!(!allow_pair_prompt(&mut seen, "peer-a", now));
        assert!(
            allow_pair_prompt(&mut seen, "peer-b", now),
            "a different device asking is a different request"
        );
    }

    #[test]
    fn the_pair_request_history_is_bounded() {
        let mut seen = Vec::new();
        for i in 0..MAX_PAIR_REQUEST_SENDERS * 2 {
            assert!(allow_pair_prompt(
                &mut seen,
                &format!("peer-{i}"),
                1_000_000
            ));
        }
        assert_eq!(seen.len(), MAX_PAIR_REQUEST_SENDERS);
    }

    #[test]
    fn a_sealed_message_verifies_on_the_receiving_side() {
        let (mgr, node_id) = manager_with_identity();
        let msg = mgr
            .seal("peer-node", "offer", "sdp-payload".to_string())
            .unwrap();

        assert_eq!(msg.from, node_id);
        assert_eq!(msg.to.as_deref(), Some("peer-node"));
        assert!(!msg.sig.is_empty() && !msg.nonce.is_empty());

        let mut verifier = EnvelopeVerifier::new();
        assert!(verifier
            .verify(
                &msg.from,
                "peer-node",
                &msg.msg_type,
                &msg.payload,
                msg.ts,
                &msg.nonce,
                &msg.sig,
                crypto::now_ms(),
            )
            .is_ok());
    }

    #[test]
    fn a_sealed_message_does_not_verify_for_a_different_recipient() {
        let (mgr, _) = manager_with_identity();
        let msg = mgr.seal("peer-node", "offer", "sdp".to_string()).unwrap();

        let mut verifier = EnvelopeVerifier::new();
        assert!(
            verifier
                .verify(
                    &msg.from,
                    "someone-else",
                    &msg.msg_type,
                    &msg.payload,
                    msg.ts,
                    &msg.nonce,
                    &msg.sig,
                    crypto::now_ms(),
                )
                .is_err(),
            "a message addressed to one peer must not verify for another"
        );
    }

    #[test]
    fn each_sealed_message_gets_a_fresh_nonce() {
        let (mgr, _) = manager_with_identity();
        let a = mgr.seal("peer", "offer", "x".to_string()).unwrap();
        let b = mgr.seal("peer", "offer", "x".to_string()).unwrap();
        assert_ne!(a.nonce, b.nonce, "a repeated nonce would read as a replay");
    }

    // Publishing unsigned would be worse than not publishing: the peer would
    // reject it, and the failure would look like a network problem.
    #[test]
    fn sealing_without_an_identity_fails_rather_than_sending_unsigned() {
        let mgr = SignalingManager::new(None);
        let err = mgr.seal("peer", "offer", "sdp".to_string()).unwrap_err();
        assert!(err.contains("identity not loaded"), "got: {err}");
    }
}
