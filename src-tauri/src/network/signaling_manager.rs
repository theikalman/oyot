//! Who we are, who we trust, and how a signaling message gets to a peer.
//!
//! There is one way, and it is the local network. The broker that used to sit
//! behind it, the per-peer route choice and the cooldown that moved a stalled
//! peer onto the other route are all gone with ADR 0022; what is left is
//! "where is this peer, and can we reach it there".

use crate::crypto::{self, EnvelopeVerifier};
use crate::db::AppState;
use crate::identity::LocalIdentity;
use crate::network::lan_signaling;
use crate::network::message::SignalingMessage;
use crate::network::peers::{Peer, Peers};
use crate::pairing;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// How often one sender may raise a pairing prompt.
///
/// A signature proves who sent a request, not that we want it. Anyone on this
/// network can reach the listener, and every valid request put a modal in
/// front of the user, so an unpaired device could make the app unusable by
/// asking repeatedly. Declining is still the answer to a request you did not
/// expect; this only stops it being asked faster than a person can read it.
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
    /// This device's identity and signing key. Every outgoing message is signed
    /// with it, and `node_id` is the public half peers verify against.
    identity: Arc<ParkingMutex<Option<LocalIdentity>>>,
    // Peers we've explicitly agreed to pair with during this session (accepted a
    // pair-request from them, or had our pair-request accepted). Consulted when an
    // "offer" arrives from a node_id that isn't already in the persisted device_pairs
    // table, so unsolicited offers from unpaired/unauthorized nodes get dropped instead
    // of silently auto-accepted.
    authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
    /// Signature, freshness and replay checks for every inbound message. One
    /// instance for the life of the process: it used to be built per MQTT
    /// client generation, and a per-transport copy holds only half the nonce
    /// history. There is one transport now, but the verifier stays here
    /// because that is where a second one would find it. See `Inbound`.
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
    /// Held here for the same reason: a pairing prompt the user has just
    /// dismissed should stay dismissed however the next copy of the request
    /// arrives.
    pair_prompts: Arc<ParkingMutex<Vec<(String, i64)>>>,
    /// Who is reachable, by whichever route found them. Shared with every
    /// discovery source rather than owned here (ADR 0023).
    peers: Arc<Peers>,
}

impl SignalingManager {
    /// The handle the frontend is spoken to through is not held here: the
    /// only thing that emits is `Inbound`, which is handed one when the
    /// listener starts. It was a field while the broker's event forwarder
    /// needed one of its own.
    pub fn new(peers: Arc<Peers>) -> Self {
        Self {
            identity: Arc::new(ParkingMutex::new(None)),
            authorized_peers: Arc::new(ParkingMutex::new(HashMap::new())),
            verifier: Arc::new(ParkingMutex::new(EnvelopeVerifier::new())),
            pair_prompts: Arc::new(ParkingMutex::new(Vec::new())),
            peers,
        }
    }

    /// The best way to reach this peer, if there is one.
    ///
    /// `None` is the whole of "we cannot reach it": it is not on this network
    /// and no address we hold for it answered.
    fn route_to(&self, peer_id: &str) -> Option<Peer> {
        self.peers.best(peer_id)
    }

    /// The inbound half, for the listener to hand received messages to.
    ///
    /// `node_id` and the user id are snapshots taken when the listener starts;
    /// neither changes after startup.
    pub fn inbound(&self, app: AppHandle, node_id: &str, boot_id: &str) -> Inbound {
        Inbound {
            app,
            node_id: node_id.to_string(),
            our_user_id: self.get_user_id(),
            boot_id: boot_id.to_string(),
            identity: self.identity.clone(),
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
        seal_with(&self.identity, to, msg_type, payload)
    }

    /// Seal a message for a peer, ready to send (ADR 0023's prober needs one
    /// without going through `publish`, which would look the peer up in the
    /// very table the probe is about to fill).
    pub fn seal_for(
        &self,
        to: &str,
        msg_type: &str,
        payload: String,
    ) -> Result<SignalingMessage, String> {
        self.seal(to, msg_type, payload)
    }

    /// Whether a message we received out-of-band is one we can trust: addressed
    /// to us, signed by the node it claims, recent, and not seen before.
    ///
    /// Shares the verifier with `Inbound`, so a nonce spent on a probe reply
    /// cannot be spent again anywhere else.
    pub fn admit_reply(&self, msg: &SignalingMessage) -> bool {
        admit(&self.verifier, &self.get_node_id(), msg)
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

    /// Sign one message and send it to a peer, wherever it was found.
    ///
    /// Every outgoing message goes through here, so there is no path that
    /// sends an unsigned envelope.
    ///
    /// A failure is final for this message. The peer table already picked the
    /// best route, and trying the other one on a send failure would only move
    /// the retry a few hundred milliseconds earlier than the caller's backoff
    /// does anyway, at the cost of a route choice in two places.
    async fn publish(&self, peer_id: &str, msg_type: &str, payload: String) -> Result<(), String> {
        let Some(peer) = self.route_to(peer_id) else {
            return Err(format!(
                "{peer_id} is not on this network and no stored address for it answered"
            ));
        };

        trace!(
            "[Signaling] publish {} to peer_id={} via {:?}",
            msg_type,
            peer_id,
            peer.source
        );
        let msg = self.seal(peer_id, msg_type, payload)?;

        lan_signaling::send_to(&peer.addrs, peer.port, &msg)
            .await
            .map_err(|e| {
                warn_log!("[Signaling] send to {} failed: {}", peer_id, e);
                e
            })
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

/// Wrap a payload in a signed envelope for one recipient.
///
/// A free function rather than a method because both halves of signaling need
/// it now: the manager to publish, and `Inbound` to answer a probe on the
/// connection it arrived on.
fn seal_with(
    identity: &ParkingMutex<Option<LocalIdentity>>,
    to: &str,
    msg_type: &str,
    payload: String,
) -> Result<SignalingMessage, String> {
    let guard = identity.lock();
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

/// Whether a message is addressed to us and provably came from the device it
/// claims to, recently, and only once.
///
/// Runs before anything reads the payload: the transport is not trusted, and
/// `from` is whatever the sender chose to write.
///
/// Takes the verifier rather than owning one, so the nonce history has a
/// single home. See `Inbound`.
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

/// The inbound half of signaling: what to do with a message that has arrived.
///
/// Held by the manager and cloned into the listener's accept loop, so the
/// replay history and the pairing-prompt cooldown live in one place rather
/// than one per transport. That mattered when there were two of them (ADR
/// 0018) and is why it is still shaped this way with one.
#[derive(Clone)]
pub struct Inbound {
    app: AppHandle,
    /// Our own node_id, as the `to` every message must be addressed to.
    node_id: String,
    our_user_id: String,
    /// This run of the process, which a `pong` carries so the asker can tell a
    /// device that restarted from one that never went away.
    boot_id: String,
    /// The signing key, for the one message type that is answered here rather
    /// than by the frontend.
    identity: Arc<ParkingMutex<Option<LocalIdentity>>>,
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
    pair_prompts: Arc<ParkingMutex<Vec<(String, i64)>>>,
    authorized_peers: Arc<ParkingMutex<HashMap<String, PeerContext>>>,
}

impl Inbound {
    /// Verify, then dispatch. The single entry point for an arriving message.
    ///
    /// Returns a message to write back on the same connection, which only a
    /// `ping` produces. Every other type is answered, if at all, by the
    /// frontend opening a connection of its own, and returns `None` here.
    pub async fn receive(&self, msg: SignalingMessage) -> Option<SignalingMessage> {
        if !admit(&self.verifier, &self.node_id, &msg) {
            return None;
        }
        self.dispatch(msg).await
    }

    /// Answer a probe (ADR 0023).
    ///
    /// Answered for any correctly signed and correctly addressed sender, paired
    /// or not: an address is how an unpaired device is reached in the first
    /// place, so refusing strangers here would make pairing over a stored
    /// address impossible. What the reply discloses is that this node is at
    /// this address, to someone who already knew its node_id and could already
    /// reach the port.
    fn pong(&self, to: &str) -> Option<SignalingMessage> {
        let payload = serde_json::json!({ "boot_id": self.boot_id }).to_string();
        match seal_with(&self.identity, to, "pong", payload) {
            Ok(msg) => Some(msg),
            Err(e) => {
                warn_log!("[Signaling] cannot answer a ping: {}", e);
                None
            }
        }
    }

    async fn dispatch(&self, msg: SignalingMessage) -> Option<SignalingMessage> {
        trace!(
            "[Signaling] dispatch() type={} from={} our_user_id={}",
            msg.msg_type,
            msg.from,
            self.our_user_id
        );
        match msg.msg_type.as_str() {
            "ping" => return self.pong(&msg.from),
            // The prober reads a pong off the connection it sent the ping on,
            // so one arriving here is a stray. Saying so beats "unknown type".
            "pong" => trace!("[Signaling] unsolicited pong from {}, ignoring", msg.from),
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
                        return None;
                    }
                    let _ = self.app.emit(
                        "signaling-pair-request-received",
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
                    let _ = self.app.emit(
                        "signaling-pair-response-received",
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
                self.handle_offer(msg).await;
            }
            "answer" => {
                trace!(
                    "[Signaling] Emitting signaling-answer-received from={}",
                    msg.from
                );
                let payload = serde_json::json!({
                    "from": msg.from,
                    "sdp": msg.payload,
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
        None
    }

    /// Resolves an incoming offer's sender against two trust sources, in order:
    /// 1. Already-persisted device_pairs (a previously completed pairing reconnecting,
    ///    e.g. after an app restart) - reuses the stored room_id directly.
    /// 2. In-memory authorized_peers (a pairing handshake accepted earlier this session)
    ///    - derives room_id from the two real user_ids exchanged during that handshake.
    ///
    /// If neither matches, the offer is from a node we never agreed to pair with and is
    /// dropped rather than auto-accepted.
    async fn handle_offer(&self, msg: SignalingMessage) {
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
            "[Signaling] Emitting signaling-offer-received from={} room_id={}",
            msg.from,
            room_id
        );
        let payload = serde_json::json!({
            "from": msg.from,
            "sdp": msg.payload,
            "room_id": room_id,
            "display_name": display_name,
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
        let mgr = SignalingManager::new(Arc::new(Peers::new(None)));
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

    // The whole reason the verifier lives on the manager rather than on the
    // listener. An envelope that has been admitted once must not be admitted
    // again inside the clock-skew window, however it arrives the second time.
    #[test]
    fn an_envelope_admitted_once_is_refused_when_it_comes_back() {
        let (mgr, _) = manager_with_identity();
        let msg = mgr.seal("peer-node", "offer", "sdp".to_string()).unwrap();
        let shared = ParkingMutex::new(EnvelopeVerifier::new());

        assert!(
            admit(&shared, "peer-node", &msg),
            "the message as it genuinely arrives the first time"
        );
        assert!(
            !admit(&shared, "peer-node", &msg),
            "the same envelope replayed"
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
        let mgr = SignalingManager::new(Arc::new(Peers::new(None)));
        let err = mgr.seal("peer", "offer", "sdp".to_string()).unwrap_err();
        assert!(err.contains("identity not loaded"), "got: {err}");
    }
}
