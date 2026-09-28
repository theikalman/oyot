//! What the engine tells the page (ADR 0031, decisions 5, 7 and 9).
//!
//! The engine does not know whether a page is there. Under Tauri, `TauriEvents`
//! emits these to it; in a phone's background run there is none, and every
//! method falls through to doing nothing (ADR 0031, decision 8).

use super::protocol::ManifestEntry;

pub trait Events: Send + Sync {
    /// A peer created a document, or revived one this device had deleted.
    fn doc_created(&self, _entry: &ManifestEntry) {}
    fn doc_renamed(&self, _id: &str, _title: &str, _title_updated_at: i64) {}
    fn doc_pinned(&self, _id: &str, _pinned: bool, _pinned_updated_at: i64) {}
    fn doc_deleted(&self, _id: &str) {}
    /// A peer's update was merged into a document's stored state, and
    /// `update` is what it added. The page applies it to the open copy, if it
    /// has one, and re-indexes the document.
    fn doc_merged(&self, _id: &str, _update: &[u8]) {}
    fn attachment_downloaded(&self, _hash: &str) {}
    /// How one paired device stands: connected or not, and how far along.
    fn peer_state(&self, _state: &PeerState) {}
    /// A device that is not paired asked to be (ADR 0032, decision 5).
    fn pair_requested(&self, _from: &str, _user_id: &str, _display_name: &str) {}
    /// The device this one asked to pair with answered.
    fn pair_answered(&self, _from: &str, _user_id: &str, _display_name: &str, _accepted: bool) {}
}

/// One paired device's connection, as the page shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerState {
    pub peer_node_id: String,
    pub display_name: String,
    pub room_id: String,
    pub connected: bool,
    /// A connection is being made, or will be retried.
    pub reconnecting: bool,
    /// "idle", "connecting", "reconciling", "transferring", "synced" or "error".
    pub phase: String,
    pub pending: usize,
    pub total: usize,
    pub last_synced_at: Option<i64>,
}

/// No page to tell: a background run, and tests that do not listen.
pub struct NoEvents;

impl Events for NoEvents {}
