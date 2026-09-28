//! Who we are, and the signed probe that proves a device is at an address.
//!
//! Since ADR 0032 the probe is all that is left of signaling: `ping` and
//! `pong` keep their envelopes and their short connection, a `ping` and its
//! `pong` on one (decision 4). Pairing, and everything WebRTC needed to start
//! a session, moved into the TLS connection the sync engine keeps with each
//! paired device, keyed by the same node key.

use crate::crypto::{self, EnvelopeVerifier};
use crate::identity::LocalIdentity;
use crate::network::message::SignalingMessage;
use crate::sync::protocol::PROTOCOL_VERSION;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What a probe and its answer carry.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ProbePayload {
    /// The sender's id for this run of its process, so a device that restarted
    /// reads as a change rather than as the same peer still sitting there.
    pub boot_id: String,
    /// The sync protocol the sender speaks. A device on another one is left
    /// alone rather than dialled into a handshake it cannot finish (ADR 0032,
    /// decision 9). Absent from builds before it, which speak another.
    #[serde(default)]
    pub proto: Option<String>,
}

impl ProbePayload {
    pub(crate) fn new(boot_id: &str) -> Self {
        Self {
            boot_id: boot_id.to_string(),
            proto: Some(PROTOCOL_VERSION.to_string()),
        }
    }

    pub(crate) fn speaks_ours(&self) -> bool {
        self.proto.as_deref() == Some(PROTOCOL_VERSION)
    }
}

pub struct SignalingManager {
    /// This device's identity and signing key. Every outgoing message is signed
    /// with it, and `node_id` is the public half peers verify against.
    identity: Arc<ParkingMutex<Option<LocalIdentity>>>,
    /// Signature, freshness and replay checks for every inbound message. One
    /// instance for the life of the process, shared with `Inbound`, so a
    /// nonce spent on a probe's answer cannot be spent again on a probe.
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
}

impl Default for SignalingManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SignalingManager {
    pub fn new() -> Self {
        Self {
            identity: Arc::new(ParkingMutex::new(None)),
            verifier: Arc::new(ParkingMutex::new(EnvelopeVerifier::new())),
        }
    }

    /// The inbound half, for the listener to hand received messages to.
    ///
    /// `node_id` is a snapshot taken when the listener starts; it does not
    /// change after startup.
    pub fn inbound(&self, node_id: &str, boot_id: &str) -> Inbound {
        Inbound {
            node_id: node_id.to_string(),
            boot_id: boot_id.to_string(),
            identity: self.identity.clone(),
            verifier: self.verifier.clone(),
        }
    }

    /// The public half of the loaded identity, or `None` before startup has
    /// set it. Deliberately not the whole `LocalIdentity`: callers outside
    /// this module have no business holding the signing key, and not making
    /// it cloneable is what keeps that true.
    pub fn public_identity(&self) -> Option<crate::identity::UserIdentity> {
        self.identity.lock().as_ref().map(|i| i.public.clone())
    }

    /// Keep the in-memory copy in step with a rename, so `get_identity` shows
    /// the new name rather than the one loaded at startup.
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

    /// Seal a message for a peer, ready to send.
    pub fn seal_for(
        &self,
        to: &str,
        msg_type: &str,
        payload: String,
    ) -> Result<SignalingMessage, String> {
        seal_with(&self.identity, to, msg_type, payload)
    }

    /// Whether an answer we read off our own connection is one we can trust:
    /// addressed to us, signed by the node it claims, recent, and not seen
    /// before.
    pub fn admit_reply(&self, msg: &SignalingMessage) -> bool {
        admit(&self.verifier, &self.get_node_id(), msg)
    }
}

/// Wrap a payload in a signed envelope for one recipient.
///
/// A free function rather than a method because both halves need it: the
/// prober to ask, and `Inbound` to answer on the connection the asking
/// arrived on.
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

/// The inbound half: what to do with a signed message that has arrived on the
/// listener. Cloned into the listener's accept loop, with the replay history
/// shared through the manager.
#[derive(Clone)]
pub struct Inbound {
    /// Our own node_id, as the `to` every message must be addressed to.
    node_id: String,
    /// This run of the process, which a `pong` carries so the asker can tell a
    /// device that restarted from one that never went away.
    boot_id: String,
    identity: Arc<ParkingMutex<Option<LocalIdentity>>>,
    verifier: Arc<ParkingMutex<EnvelopeVerifier>>,
}

impl Inbound {
    /// Verify, then answer. The single entry point for an arriving message.
    ///
    /// Returns the message to write back on the same connection, which only a
    /// `ping` from a device speaking this protocol gets.
    pub fn receive(&self, msg: SignalingMessage) -> Option<SignalingMessage> {
        if !admit(&self.verifier, &self.node_id, &msg) {
            return None;
        }
        match msg.msg_type.as_str() {
            "ping" => self.pong(&msg),
            // The prober reads a pong off the connection it sent the ping on,
            // so one arriving here is a stray.
            "pong" => {
                trace!("[Signaling] unsolicited pong from {}, ignoring", msg.from);
                None
            }
            // Offers, answers, candidates and pair requests from a build
            // before ADR 0032, which this one does not speak.
            other => {
                trace!(
                    "[Signaling] ignoring a {other} from {}, which speaks an older protocol",
                    msg.from
                );
                None
            }
        }
    }

    /// Answer a probe (ADR 0023).
    ///
    /// Answered for any correctly signed and correctly addressed sender, paired
    /// or not: an address is how an unpaired device is reached in the first
    /// place, so refusing strangers here would make pairing over a stored
    /// address impossible. What the reply discloses is that this node is at
    /// this address, to someone who already knew its node_id and could already
    /// reach the port.
    ///
    /// Not answered for a device on another protocol, which could reach this
    /// one and do nothing with it (ADR 0032, decision 9).
    fn pong(&self, ping: &SignalingMessage) -> Option<SignalingMessage> {
        let speaks_ours = serde_json::from_str::<ProbePayload>(&ping.payload)
            .map(|p| p.speaks_ours())
            .unwrap_or(false);
        if !speaks_ours {
            trace!(
                "[Signaling] not answering {}, which speaks another protocol",
                ping.from
            );
            return None;
        }
        let payload = match serde_json::to_string(&ProbePayload::new(&self.boot_id)) {
            Ok(payload) => payload,
            Err(e) => {
                warn_log!("[Signaling] cannot answer a ping: {}", e);
                return None;
            }
        };
        match seal_with(&self.identity, &ping.from, "pong", payload) {
            Ok(msg) => Some(msg),
            Err(e) => {
                warn_log!("[Signaling] cannot answer a ping: {}", e);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::EnvelopeVerifier;
    use crate::identity::{LocalIdentity, UserIdentity};

    fn manager_with_identity(name: &str) -> (SignalingManager, String) {
        let signing_key = crypto::generate_signing_key();
        let node_id = crypto::encode_node_id(&signing_key.verifying_key());
        let mgr = SignalingManager::new();
        mgr.set_identity(LocalIdentity {
            public: UserIdentity {
                user_id: format!("user-{name}"),
                node_id: node_id.clone(),
                display_name: name.to_string(),
            },
            signing_key,
        });
        (mgr, node_id)
    }

    fn ping_payload(proto: Option<&str>) -> String {
        match proto {
            Some(proto) => serde_json::json!({ "boot_id": "boot-a", "proto": proto }),
            None => serde_json::json!({ "boot_id": "boot-a" }),
        }
        .to_string()
    }

    // The unit tests in crypto cover the primitives; this covers the wiring,
    // i.e. that what seal_for() produces is what a peer's verifier accepts.
    #[test]
    fn a_sealed_message_verifies_on_the_receiving_side() {
        let (mgr, node_id) = manager_with_identity("Laptop");
        let msg = mgr
            .seal_for("peer-node", "ping", ping_payload(None))
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
        let (mgr, _) = manager_with_identity("Laptop");
        let msg = mgr.seal_for("peer-node", "ping", "{}".to_string()).unwrap();
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
        let (mgr, _) = manager_with_identity("Laptop");
        let msg = mgr.seal_for("peer-node", "ping", "{}".to_string()).unwrap();
        let shared = ParkingMutex::new(EnvelopeVerifier::new());

        assert!(!admit(&shared, "a-different-device", &msg));
    }

    #[test]
    fn each_sealed_message_gets_a_fresh_nonce() {
        let (mgr, _) = manager_with_identity("Laptop");
        let a = mgr.seal_for("peer", "ping", "x".to_string()).unwrap();
        let b = mgr.seal_for("peer", "ping", "x".to_string()).unwrap();
        assert_ne!(a.nonce, b.nonce, "a repeated nonce would read as a replay");
    }

    // Publishing unsigned would be worse than not publishing: the peer would
    // reject it, and the failure would look like a network problem.
    #[test]
    fn sealing_without_an_identity_fails_rather_than_sending_unsigned() {
        let mgr = SignalingManager::new();
        let err = mgr.seal_for("peer", "ping", "{}".to_string()).unwrap_err();
        assert!(err.contains("identity not loaded"), "got: {err}");
    }

    #[test]
    fn a_ping_in_this_protocol_is_answered_with_a_pong_in_it() {
        let (asker, asker_id) = manager_with_identity("Phone");
        let (answerer, answerer_id) = manager_with_identity("Laptop");
        let inbound = answerer.inbound(&answerer_id, "boot-b");
        let ping = asker
            .seal_for(&answerer_id, "ping", ping_payload(Some(PROTOCOL_VERSION)))
            .unwrap();

        let pong = inbound.receive(ping).expect("answered");

        assert_eq!(pong.msg_type, "pong");
        assert_eq!(pong.to.as_deref(), Some(asker_id.as_str()));
        let payload: ProbePayload = serde_json::from_str(&pong.payload).unwrap();
        assert_eq!(payload.boot_id, "boot-b");
        assert!(payload.speaks_ours());
        assert!(asker.admit_reply(&pong));
    }

    // A build before ADR 0032 would take the answer as a route and then offer
    // WebRTC down it, which nothing here speaks any more.
    #[test]
    fn a_ping_from_a_build_on_another_protocol_is_not_answered() {
        let (asker, _) = manager_with_identity("Phone");
        let (answerer, answerer_id) = manager_with_identity("Laptop");
        let inbound = answerer.inbound(&answerer_id, "boot-b");

        let old = asker
            .seal_for(&answerer_id, "ping", ping_payload(None))
            .unwrap();
        let other = asker
            .seal_for(&answerer_id, "ping", ping_payload(Some("1")))
            .unwrap();

        assert!(inbound.receive(old).is_none());
        assert!(inbound.receive(other).is_none());
    }

    #[test]
    fn what_an_older_build_sends_to_start_webrtc_is_ignored() {
        let (asker, _) = manager_with_identity("Phone");
        let (answerer, answerer_id) = manager_with_identity("Laptop");
        let inbound = answerer.inbound(&answerer_id, "boot-b");

        for kind in ["offer", "answer", "ice-candidate", "pair-request"] {
            let msg = asker
                .seal_for(&answerer_id, kind, "{}".to_string())
                .unwrap();
            assert!(inbound.receive(msg).is_none(), "{kind}");
        }
    }
}
