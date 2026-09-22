//! The signaling envelope, independent of whatever carries it.
//!
//! It lived in `mqtt_client.rs` while MQTT was the only transport, which made
//! the one transport's module the home of the format every transport speaks.
//! [ADR 0022](../../../docs/decisions/0022-drop-the-broker-and-sync-only-on-the-local-network.md)
//! removed that transport; the envelope outlived it, so it has a module of its
//! own.

use serde::{Deserialize, Serialize};

/// A signaling message as it travels between two devices.
///
/// `from` is the sender's Ed25519 public key and `sig` covers every other
/// field, so whatever relays or delivers it can neither forge nor alter it.
/// `ts` and `nonce` make each one fresh and single-use. See crate::crypto, and
/// docs/decisions/0009-authenticated-signaling.md for why the transport is
/// never the thing that makes a message trustworthy.
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
