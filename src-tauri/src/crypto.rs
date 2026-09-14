//! Device identity and signed signaling envelopes.
//!
//! A device's `node_id` IS its Ed25519 public key, base64url-unpadded. That is
//! what makes the signaling broker untrusted infrastructure rather than a trust
//! anchor: anyone can relay our messages, but only the holder of the matching
//! secret key can produce one that verifies as coming from us.
//!
//! See docs/decisions/0009-authenticated-signaling.md.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier as _, VerifyingKey};
use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

/// How far a message's timestamp may be from ours before we reject it. Covers
/// ordinary clock skew between two personal devices without leaving a wide
/// replay window.
pub const MAX_CLOCK_SKEW_MS: i64 = 120_000;

/// Nonces remembered per peer for replay detection. A signaling exchange is a
/// handful of messages, so this is generous; it is bounded so a peer cannot
/// grow it without limit.
const NONCE_HISTORY: usize = 256;

/// How many distinct senders we keep nonce history for.
///
/// This used to be one shared list, despite the comment above saying
/// otherwise: 256 entries across all senders, so anyone holding any key could
/// push 256 valid messages of their own and evict a real peer's history,
/// making a captured message from that peer replayable inside the timestamp
/// window. A personal install talks to a handful of devices, so a per-sender
/// history costs nothing and removes that.
///
/// The map is still bounded, or a sender with many keys would grow it without
/// limit, and eviction is by insertion order. Filling it still takes 32
/// distinct valid keypairs, and the prize is replaying one signaling message
/// inside 120 seconds, which the pairing check and perfect negotiation both
/// absorb. That residue is acceptable; silently sharing one list was not.
const MAX_TRACKED_SENDERS: usize = 32;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// base64url-unpadded of the 32-byte public key: 43 characters, and every
/// character is safe in an MQTT topic segment (the alphabet has no `/`, `+` or
/// `#`).
pub fn encode_node_id(key: &VerifyingKey) -> String {
    URL_SAFE_NO_PAD.encode(key.as_bytes())
}

pub fn decode_node_id(node_id: &str) -> Option<VerifyingKey> {
    let bytes = URL_SAFE_NO_PAD.decode(node_id).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

pub fn generate_signing_key() -> SigningKey {
    SigningKey::generate(&mut rand::rngs::OsRng)
}

pub fn signing_key_from_bytes(bytes: &[u8]) -> Option<SigningKey> {
    let arr: [u8; 32] = bytes.try_into().ok()?;
    Some(SigningKey::from_bytes(&arr))
}

pub fn random_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The exact bytes covered by a signature.
///
/// Every field is length-prefixed rather than joined with a separator. Joining
/// would let a value containing the separator shift the field boundaries, so a
/// sender could craft a `payload` that re-parses as a different `to` and
/// `msg_type` and have one signature validate two different messages.
fn signing_bytes(
    from: &str,
    to: &str,
    msg_type: &str,
    payload: &str,
    ts: i64,
    nonce: &str,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"oyot-signaling-v1");
    for field in [from, to, msg_type, payload, nonce] {
        out.extend_from_slice(&(field.len() as u64).to_be_bytes());
        out.extend_from_slice(field.as_bytes());
    }
    out.extend_from_slice(&ts.to_be_bytes());
    out
}

pub fn sign(
    key: &SigningKey,
    from: &str,
    to: &str,
    msg_type: &str,
    payload: &str,
    ts: i64,
    nonce: &str,
) -> String {
    let bytes = signing_bytes(from, to, msg_type, payload, ts, nonce);
    URL_SAFE_NO_PAD.encode(key.sign(&bytes).to_bytes())
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// `from` is not a well-formed public key.
    BadSenderKey,
    /// Signature missing, malformed, or not produced by `from`'s key.
    BadSignature,
    /// Timestamp outside the accepted window, in either direction.
    StaleTimestamp,
    /// This (sender, nonce) pair has already been seen.
    Replay,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            VerifyError::BadSenderKey => "sender node_id is not a valid public key",
            VerifyError::BadSignature => "signature does not verify against the sender's key",
            VerifyError::StaleTimestamp => "timestamp outside the accepted window",
            VerifyError::Replay => "nonce already seen from this sender",
        };
        f.write_str(s)
    }
}

/// Checks a message's signature, freshness and novelty.
///
/// This answers "did the holder of `from`'s secret key send this, recently, and
/// only once". It says nothing about whether we want to talk to that device -
/// that is the pairing check, which stays where it was.
pub struct EnvelopeVerifier {
    seen: HashMap<String, VecDeque<String>>,
    /// Senders in the order they were first seen, so the map can be bounded.
    order: VecDeque<String>,
}

impl EnvelopeVerifier {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify(
        &mut self,
        from: &str,
        to: &str,
        msg_type: &str,
        payload: &str,
        ts: i64,
        nonce: &str,
        sig: &str,
        now: i64,
    ) -> Result<(), VerifyError> {
        let key = decode_node_id(from).ok_or(VerifyError::BadSenderKey)?;

        if (now - ts).abs() > MAX_CLOCK_SKEW_MS {
            return Err(VerifyError::StaleTimestamp);
        }

        let sig_bytes = URL_SAFE_NO_PAD
            .decode(sig)
            .map_err(|_| VerifyError::BadSignature)?;
        let sig_arr: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| VerifyError::BadSignature)?;
        let signature = Signature::from_bytes(&sig_arr);

        let bytes = signing_bytes(from, to, msg_type, payload, ts, nonce);
        key.verify(&bytes, &signature)
            .map_err(|_| VerifyError::BadSignature)?;

        // Only after the signature checks out: an unverified sender must not be
        // able to fill our nonce history.
        let history = match self.seen.get_mut(from) {
            Some(history) => history,
            None => {
                if self.order.len() >= MAX_TRACKED_SENDERS {
                    if let Some(evicted) = self.order.pop_front() {
                        self.seen.remove(&evicted);
                    }
                }
                self.order.push_back(from.to_string());
                self.seen.entry(from.to_string()).or_default()
            }
        };

        if history.contains(&nonce.to_string()) {
            return Err(VerifyError::Replay);
        }
        if history.len() == NONCE_HISTORY {
            history.pop_front();
        }
        history.push_back(nonce.to_string());

        Ok(())
    }
}

impl Default for EnvelopeVerifier {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts() -> (SigningKey, String) {
        let key = generate_signing_key();
        let node_id = encode_node_id(&key.verifying_key());
        (key, node_id)
    }

    fn signed(key: &SigningKey, from: &str, payload: &str, ts: i64, nonce: &str) -> String {
        sign(key, from, "peer", "offer", payload, ts, nonce)
    }

    #[test]
    fn a_node_id_round_trips_through_its_encoding() {
        let (key, node_id) = parts();
        assert_eq!(node_id.len(), 43, "43 chars of base64url for 32 bytes");
        assert!(
            !node_id.contains('/') && !node_id.contains('+') && !node_id.contains('#'),
            "must be safe in an MQTT topic segment: {node_id}"
        );
        let decoded = decode_node_id(&node_id).expect("decodes");
        assert_eq!(decoded, key.verifying_key());
    }

    #[test]
    fn garbage_is_not_a_node_id() {
        for bad in ["", "not-a-key", "!!!!", &"A".repeat(100)] {
            assert!(decode_node_id(bad).is_none(), "accepted {bad:?}");
        }
    }

    #[test]
    fn a_genuine_message_verifies() {
        let (key, node_id) = parts();
        let now = now_ms();
        let sig = signed(&key, &node_id, "sdp-here", now, "n1");
        let mut v = EnvelopeVerifier::new();
        assert_eq!(
            v.verify(&node_id, "peer", "offer", "sdp-here", now, "n1", &sig, now),
            Ok(())
        );
    }

    #[test]
    fn a_forged_sender_is_rejected() {
        // The attack the UUID identity allowed: claim to be a node we are not.
        let (attacker_key, _) = parts();
        let (_, victim_node_id) = parts();
        let now = now_ms();
        // Attacker signs with their own key but puts the victim's id in `from`.
        let sig = signed(&attacker_key, &victim_node_id, "sdp", now, "n1");

        let mut v = EnvelopeVerifier::new();
        assert_eq!(
            v.verify(
                &victim_node_id,
                "peer",
                "offer",
                "sdp",
                now,
                "n1",
                &sig,
                now
            ),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn mutating_any_signed_field_breaks_the_signature() {
        let (key, node_id) = parts();
        let now = now_ms();
        let sig = signed(&key, &node_id, "original", now, "n1");
        let mut v = EnvelopeVerifier::new();

        // payload
        assert_eq!(
            v.verify(&node_id, "peer", "offer", "tampered", now, "n1", &sig, now),
            Err(VerifyError::BadSignature)
        );
        // message type
        assert_eq!(
            v.verify(&node_id, "peer", "answer", "original", now, "n1", &sig, now),
            Err(VerifyError::BadSignature)
        );
        // recipient
        assert_eq!(
            v.verify(
                &node_id,
                "someone-else",
                "offer",
                "original",
                now,
                "n1",
                &sig,
                now
            ),
            Err(VerifyError::BadSignature)
        );
        // nonce
        assert_eq!(
            v.verify(&node_id, "peer", "offer", "original", now, "n2", &sig, now),
            Err(VerifyError::BadSignature)
        );
        // timestamp
        assert_eq!(
            v.verify(
                &node_id,
                "peer",
                "offer",
                "original",
                now + 1,
                "n1",
                &sig,
                now
            ),
            Err(VerifyError::BadSignature)
        );
    }

    // Length prefixing exists for exactly this: with fields joined by a
    // separator, a payload containing it could shift the boundaries so one
    // signature covers two different readings of the message.
    #[test]
    fn field_boundaries_cannot_be_shifted() {
        let a = signing_bytes("from", "to", "type", "payload", 1, "nonce");
        let b = signing_bytes("from", "to", "typepay", "load", 1, "nonce");
        assert_ne!(a, b);

        let c = signing_bytes("a", "bc", "d", "e", 1, "f");
        let d = signing_bytes("ab", "c", "d", "e", 1, "f");
        assert_ne!(c, d);
    }

    #[test]
    fn a_replayed_message_is_rejected_the_second_time() {
        let (key, node_id) = parts();
        let now = now_ms();
        let sig = signed(&key, &node_id, "sdp", now, "n1");
        let mut v = EnvelopeVerifier::new();

        assert_eq!(
            v.verify(&node_id, "peer", "offer", "sdp", now, "n1", &sig, now),
            Ok(())
        );
        assert_eq!(
            v.verify(&node_id, "peer", "offer", "sdp", now, "n1", &sig, now),
            Err(VerifyError::Replay)
        );
    }

    #[test]
    fn the_same_nonce_from_a_different_sender_is_fine() {
        let (key_a, id_a) = parts();
        let (key_b, id_b) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        let sig_a = signed(&key_a, &id_a, "sdp", now, "shared");
        let sig_b = signed(&key_b, &id_b, "sdp", now, "shared");

        assert_eq!(
            v.verify(&id_a, "peer", "offer", "sdp", now, "shared", &sig_a, now),
            Ok(())
        );
        assert_eq!(
            v.verify(&id_b, "peer", "offer", "sdp", now, "shared", &sig_b, now),
            Ok(())
        );
    }

    #[test]
    fn an_old_or_future_timestamp_is_rejected() {
        let (key, node_id) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        for offset in [-MAX_CLOCK_SKEW_MS - 1, MAX_CLOCK_SKEW_MS + 1] {
            let ts = now + offset;
            let sig = signed(&key, &node_id, "sdp", ts, "n1");
            assert_eq!(
                v.verify(&node_id, "peer", "offer", "sdp", ts, "n1", &sig, now),
                Err(VerifyError::StaleTimestamp),
                "offset {offset} should be outside the window"
            );
        }
    }

    #[test]
    fn skew_inside_the_window_is_accepted() {
        let (key, node_id) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        for (i, offset) in [-MAX_CLOCK_SKEW_MS + 1, 0, MAX_CLOCK_SKEW_MS - 1]
            .iter()
            .enumerate()
        {
            let ts = now + offset;
            let nonce = format!("n{i}");
            let sig = signed(&key, &node_id, "sdp", ts, &nonce);
            assert_eq!(
                v.verify(&node_id, "peer", "offer", "sdp", ts, &nonce, &sig, now),
                Ok(()),
                "offset {offset} should be inside the window"
            );
        }
    }

    // A stale message must not consume nonce history: otherwise anyone who can
    // reach the broker could evict our real entries by flooding old messages.
    #[test]
    fn a_rejected_message_does_not_consume_nonce_history() {
        let (key, node_id) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        let stale_ts = now - MAX_CLOCK_SKEW_MS - 1;
        let stale_sig = signed(&key, &node_id, "sdp", stale_ts, "n1");
        let _ = v.verify(
            &node_id, "peer", "offer", "sdp", stale_ts, "n1", &stale_sig, now,
        );
        assert!(v.seen.is_empty());

        // The same nonce is still usable on a fresh message.
        let sig = signed(&key, &node_id, "sdp", now, "n1");
        assert_eq!(
            v.verify(&node_id, "peer", "offer", "sdp", now, "n1", &sig, now),
            Ok(())
        );
    }

    #[test]
    fn nonce_history_is_bounded() {
        let (key, node_id) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        for i in 0..NONCE_HISTORY + 50 {
            let nonce = format!("n{i}");
            let sig = signed(&key, &node_id, "sdp", now, &nonce);
            assert_eq!(
                v.verify(&node_id, "peer", "offer", "sdp", now, &nonce, &sig, now),
                Ok(())
            );
        }
        assert_eq!(v.seen[&node_id].len(), NONCE_HISTORY);
    }

    // The regression this guards: one shared list meant anyone holding any
    // key could push enough of their own messages to evict a real peer's
    // nonces, making a captured message from that peer replayable inside the
    // timestamp window.
    #[test]
    fn one_sender_cannot_evict_another_senders_nonces() {
        let (victim_key, victim) = parts();
        let (noisy_key, noisy) = parts();
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        let sig = signed(&victim_key, &victim, "sdp", now, "the-nonce");
        assert_eq!(
            v.verify(&victim, "peer", "offer", "sdp", now, "the-nonce", &sig, now),
            Ok(())
        );

        // Far more than the whole history, all validly signed, from someone else.
        for i in 0..NONCE_HISTORY * 2 {
            let nonce = format!("flood{i}");
            let s = signed(&noisy_key, &noisy, "sdp", now, &nonce);
            let _ = v.verify(&noisy, "peer", "offer", "sdp", now, &nonce, &s, now);
        }

        assert_eq!(
            v.verify(&victim, "peer", "offer", "sdp", now, "the-nonce", &sig, now),
            Err(VerifyError::Replay),
            "the victim's nonce must still be remembered"
        );
    }

    #[test]
    fn the_number_of_tracked_senders_is_bounded() {
        let now = now_ms();
        let mut v = EnvelopeVerifier::new();

        for i in 0..MAX_TRACKED_SENDERS * 2 {
            let (key, node_id) = parts();
            let nonce = format!("n{i}");
            let sig = signed(&key, &node_id, "sdp", now, &nonce);
            assert_eq!(
                v.verify(&node_id, "peer", "offer", "sdp", now, &nonce, &sig, now),
                Ok(())
            );
        }

        assert_eq!(v.seen.len(), MAX_TRACKED_SENDERS);
        assert_eq!(v.order.len(), MAX_TRACKED_SENDERS);
    }

    #[test]
    fn a_stored_key_round_trips() {
        let key = generate_signing_key();
        let restored = signing_key_from_bytes(&key.to_bytes()).expect("restores");
        assert_eq!(restored.verifying_key(), key.verifying_key());
        assert!(signing_key_from_bytes(b"too short").is_none());
    }

    #[test]
    fn nonces_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(random_nonce()), "random_nonce() collided");
        }
    }
}
