//! What the engine tells the page, under Tauri (ADR 0031, decision 9).
//!
//! Event names the page already listened for keep their names: pair requests
//! and answers, and finished image downloads. The rest are new, and tell the
//! page what `transport.ts` used to work out for itself.

use super::events::{Events, PeerState};
use super::protocol::ManifestEntry;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::json;
use tauri::{AppHandle, Emitter};

pub struct TauriEvents {
    app: AppHandle,
}

impl TauriEvents {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.app.emit(event, payload) {
            warn_log!("[sync] could not tell the page {event}: {e}");
        }
    }
}

impl Events for TauriEvents {
    fn doc_created(&self, entry: &ManifestEntry) {
        self.emit("sync-doc-created", json!(entry));
    }

    fn doc_renamed(&self, id: &str, title: &str, title_updated_at: i64) {
        self.emit(
            "sync-doc-renamed",
            json!({ "id": id, "title": title, "titleUpdatedAt": title_updated_at }),
        );
    }

    fn doc_pinned(&self, id: &str, pinned: bool, pinned_updated_at: i64) {
        self.emit(
            "sync-doc-pinned",
            json!({ "id": id, "pinned": pinned, "pinnedUpdatedAt": pinned_updated_at }),
        );
    }

    fn doc_deleted(&self, id: &str) {
        self.emit("sync-doc-deleted", json!({ "id": id }));
    }

    fn doc_merged(&self, id: &str, update: &[u8]) {
        self.emit(
            "sync-doc-merged",
            json!({ "docId": id, "update": BASE64.encode(update) }),
        );
    }

    fn attachment_downloaded(&self, hash: &str) {
        self.emit("attachment-downloaded", json!({ "hash": hash }));
    }

    fn peer_state(&self, state: &PeerState) {
        self.emit("sync-peer-state", json!(state));
    }

    fn pair_requested(&self, from: &str, user_id: &str, display_name: &str) {
        self.emit(
            "signaling-pair-request-received",
            json!({ "from": from, "user_id": user_id, "display_name": display_name }),
        );
    }

    fn pair_recorded(&self, node_id: &str) {
        self.emit("sync-pair-recorded", json!({ "nodeId": node_id }));
        // A phone schedules background runs only while it has a device to
        // run them with (ADR 0034, decision 4).
        #[cfg(mobile)]
        crate::mobile::reschedule(&self.app);
    }

    fn pair_answered(&self, from: &str, user_id: &str, display_name: &str, accepted: bool) {
        self.emit(
            "signaling-pair-response-received",
            json!({
                "from": from,
                "user_id": user_id,
                "display_name": display_name,
                "accepted": accepted,
            }),
        );
    }
}
