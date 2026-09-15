use crate::crypto::{self, EnvelopeVerifier};
use crate::db::AppState;
use crate::identity::LocalIdentity;
use crate::network::mqtt_client::{MqttEvent, MqttSignalingClient, SignalingMessage};
use crate::network::route::{choose_route, Route, RouteInputs};
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
    /// Signature, freshness and replay checks for every inbound message, on
    /// every route. One instance for the life of the process: it used to be
    /// built per MQTT client generation, which was enough while the broker was
    /// the only way in, and is not once a second transport can deliver the
    /// same envelope. See `Inbound`.
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
    /// Shared for the same reason: a pairing prompt the user has just
    /// dismissed should stay dismissed no matter which transport the next copy
    /// of the request arrives on.
    pair_prompts: Arc<ParkingMutex<Vec<(String, i64)>>>,
}

impl SignalingManager {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        Self {
            mqtt_client: Arc::new(ParkingMutex::new(None)),
            identity: Arc::new(ParkingMutex::new(None)),
            app_handle,
            publish_tx: Arc::new(ParkingMutex::new(None)),
            authorized_peers: Arc::new(ParkingMutex::new(HashMap::new())),
            verifier: Arc::new(ParkingMutex::new(EnvelopeVerifier::new())),
            pair_prompts: Arc::new(ParkingMutex::new(Vec::new())),
        }
    }

    /// The inbound half, for a route to hand received messages to.
    ///
    /// `node_id` and the user id are snapshots taken when a route starts, as
    /// they were when the MQTT forwarder task captured them; neither changes
    /// after startup.
    pub fn inbound(&self, app: AppHandle, node_id: &str) -> Inbound {
        Inbound {
            app,
            node_id: node_id.to_string(),
            our_user_id: self.get_user_id(),
            verifier: self.verifier.clone(),
            pair_prompts: self.pair_prompts.clone(),
            authorized_peers: self.authorized_peers.clone(),
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
            let _ = app_handle.emit("broker-status", "connecting");
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

        if let Some(app_handle) = &self.app_handle {
            let inbound = self.inbound(app_handle.clone(), node_id);
            let app = app_handle.clone();
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
                            let _ = app.emit("broker-status", "connected");
                        }
                        MqttEvent::Disconnected => {
                            let _ = app.emit("broker-status", "disconnected");
                        }
                        MqttEvent::Error(reason) => {
                            warn_log!("[Signaling] MQTT could not connect: {}", reason);
                            let _ = app.emit("broker-status", "error");
                            let _ = app.emit("broker-error", reason);
                        }
                        MqttEvent::Message { topic, msg } => {
                            trace!(
                                "[Signaling] Received MQTT message on topic '{}': {:?}",
                                topic,
                                msg.msg_type
                            );
                            inbound.receive(msg, Route::Broker).await;
                        }
                    }
                }
            });
        }

        Ok(())
    }

    async fn send_publish(&self, topic: String, payload: Vec<u8>) -> Result<(), String> {
        let tx_opt = self.publish_tx.lock().clone();
        match tx_opt {
            Some(tx) => tx.send((topic, payload)).await.map_err(|e| e.to_string()),
            None => Err("MQTT not connected".to_string()),
        }
    }

    /// Which transport should carry a message to this peer.
    ///
    /// Only the broker answers yes for now. The LAN inputs arrive with step 3
    /// of ADR 0018; this is the seam they plug into, and `choose_route` already
    /// holds the rule they will be read by.
    fn route_for(&self, _peer_id: &str) -> Option<Route> {
        choose_route(RouteInputs {
            local_only: false,
            lan_available: false,
            broker_connected: self.publish_tx.lock().is_some(),
        })
    }

    /// Sign one message and send it to a peer by whichever route can reach it.
    ///
    /// Every outgoing message goes through here, so there is no path that
    /// publishes an unsigned envelope.
    async fn publish(&self, peer_id: &str, msg_type: &str, payload: String) -> Result<(), String> {
        let Some(route) = self.route_for(peer_id) else {
            return Err(format!("no signaling route to {peer_id}"));
        };
        trace!(
            "[Signaling] publish {} to peer_id={} over {}",
            msg_type,
            peer_id,
            route.label()
        );
        let msg = self.seal(peer_id, msg_type, payload)?;
        match route {
            Route::Broker => {
                let topic = format!("signaling/{}/{}", peer_id, msg_type);
                let bytes = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
                self.send_publish(topic, bytes).await
            }
            // Arrives with step 3 of ADR 0018, and `route_for` cannot return
            // it before then. An error rather than an `unreachable!`: these
            // calls run on detached tasks, where a panic takes sync down
            // silently and a returned error is logged by the caller.
            Route::Lan => Err(format!("no local-network route to {peer_id}")),
        }
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

/// Whether a message is addressed to us and provably came from the device it
/// claims to, recently, and only once.
///
/// Runs before anything reads the payload: no transport we use is trusted, and
/// on any of them `from` is whatever the sender chose to write.
///
/// Takes the verifier rather than owning one, because every route shares a
/// single history. See `Inbound`.
fn admit(
    verifier: &ParkingMutex<EnvelopeVerifier>,
    our_node_id: &str,
    msg: &SignalingMessage,
) -> bool {
    if msg.to.as_deref() != Some(our_node_id) {
        trace!(
            "[Signaling] Ignoring message not addressed to us (to: {:?})",
            msg.to
        );
        return false;
    }

    let result = verifier.lock().verify(
        &msg.from,
        our_node_id,
        &msg.msg_type,
        &msg.payload,
        msg.ts,
        &msg.nonce,
        &msg.sig,
        crypto::now_ms(),
    );

    if let Err(e) = result {
        warn_log!(
            "[Signaling] Rejecting {} from {}: {}",
            msg.msg_type,
            msg.from,
            e
        );
        return false;
    }
    true
}

/// The inbound half of signaling: what to do with a message that has arrived,
/// regardless of which transport carried it.
///
/// Held by the manager and cloned into each route's receive loop, so both
/// routes share one replay history and one pairing-prompt cooldown. Per-route
/// copies would mean a message captured off the broker could be replayed into
/// the LAN listener inside the clock-skew window, because the nonce that would
/// catch it was recorded in the other copy. See ADR 0018.
#[derive(Clone)]
pub struct Inbound {
    app: AppHandle,
    /// Our own node_id, as the `to` every message must be addressed to.
    node_id: String,
    our_user_id: String,
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
    pair_prompts: Arc<ParkingMutex<Vec<(String, i64)>>>,
    authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
}

impl Inbound {
    /// Verify, then dispatch. The single entry point for every route.
    pub async fn receive(&self, msg: SignalingMessage, route: Route) {
        if !admit(&self.verifier, &self.node_id, &msg) {
            return;
        }
        self.dispatch(msg, route).await;
    }

    async fn dispatch(&self, msg: SignalingMessage, route: Route) {
        trace!(
            "[Signaling] dispatch() type={} from={} route={} our_user_id={}",
            msg.msg_type,
            msg.from,
            route.label(),
            self.our_user_id
        );
        match msg.msg_type.as_str() {
            "pair-request" => match serde_json::from_str::<PairPayload>(&msg.payload) {
                Ok(req) => {
                    let allowed = {
                        let mut prompts = self.pair_prompts.lock();
                        allow_pair_prompt(&mut prompts, &msg.from, crypto::now_ms())
                    };
                    if !allowed {
                        warn_log!(
                            "[Signaling] Ignoring a repeat pair-request from {} inside the cooldown",
                            msg.from
                        );
                        return;
                    }
                    let _ = self.app.emit(
                        "signaling-pair-request-received",
                        serde_json::json!({
                            "from": msg.from,
                            "user_id": req.user_id,
                            "display_name": req.display_name,
                            "route": route.label(),
                        }),
                    );
                }
                Err(e) => warn_log!("[Signaling] Failed to parse pair-request payload: {}", e),
            },
            "pair-response" => match serde_json::from_str::<PairPayload>(&msg.payload) {
                Ok(resp) => {
                    let _ = self.app.emit(
                        "signaling-pair-response-received",
                        serde_json::json!({
                            "from": msg.from,
                            "user_id": resp.user_id,
                            "display_name": resp.display_name,
                            "accepted": resp.accepted.unwrap_or(false),
                            "route": route.label(),
                        }),
                    );
                }
                Err(e) => warn_log!("[Signaling] Failed to parse pair-response payload: {}", e),
            },
            "offer" => {
                self.handle_offer(msg, route).await;
            }
            "answer" => {
                trace!(
                    "[Signaling] Emitting signaling-answer-received from={}",
                    msg.from
                );
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
                    "route": route.label(),
                });
                let _ = self.app.emit("signaling-answer-received", payload);
            }
            "ice-candidate" => {
                trace!(
                    "[Signaling] Emitting signaling-ice-candidate-received from={}",
                    msg.from
                );
                let payload = serde_json::json!({
                    "from": msg.from,
                    "candidate": msg.payload,
                    "route": route.label(),
                });
                let _ = self.app.emit("signaling-ice-candidate-received", payload);
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
    async fn handle_offer(&self, msg: SignalingMessage, route: Route) {
        let persisted = {
            let state = self.app.state::<AppState>();
            let db = state.db.lock();
            pairing::get_pair_by_node_id(&db, &self.our_user_id, &msg.from).unwrap_or(None)
        };

        let (room_id, display_name) = if let Some(pair) = persisted {
            trace!(
                "[Signaling] Offer from already-paired node {} (trusted reconnect)",
                msg.from
            );
            (pair.room_id, pair.peer_display_name)
        } else if let Some(ctx) = self.authorized_peers.lock().get(&msg.from).cloned() {
            trace!(
                "[Signaling] Offer from session-authorized node {}",
                msg.from
            );
            (
                pairing::derive_room_id(&self.our_user_id, &ctx.user_id),
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
            "[Signaling] Emitting signaling-offer-received from={} room_id={} route={}",
            msg.from,
            room_id,
            route.label()
        );
        let payload = serde_json::json!({
            "from": msg.from,
            "sdp": msg.payload,
            "room_id": room_id,
            "display_name": display_name,
            "route": route.label(),
        });
        let _ = self.app.emit("signaling-offer-received", payload);
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

    // The whole reason the verifier moved onto the manager. Per-route copies
    // would each hold half the nonce history, so an envelope captured off the
    // broker could be replayed into the LAN listener inside the clock-skew
    // window and arrive looking genuine.
    #[test]
    fn an_envelope_admitted_on_one_route_is_refused_on_the_other() {
        let (mgr, _) = manager_with_identity();
        let msg = mgr.seal("peer-node", "offer", "sdp".to_string()).unwrap();
        let shared = ParkingMutex::new(EnvelopeVerifier::new());

        assert!(
            admit(&shared, "peer-node", &msg),
            "the message as it genuinely arrives the first time"
        );
        assert!(
            !admit(&shared, "peer-node", &msg),
            "the same envelope replayed over the other transport"
        );
    }

    #[test]
    fn a_message_addressed_to_someone_else_is_dropped_before_verification() {
        let (mgr, _) = manager_with_identity();
        let msg = mgr.seal("peer-node", "offer", "sdp".to_string()).unwrap();
        let shared = ParkingMutex::new(EnvelopeVerifier::new());

        assert!(!admit(&shared, "a-different-device", &msg));
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
