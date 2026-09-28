//! What two devices say to each other while syncing (ADR 0003, ADR 0032).
//!
//! The message set is the one `protocol.ts` defined for the WebRTC data
//! channel, carried over a TLS connection instead, with four changes:
//!
//! - Bytes travel as bytes. A message that carries a Yjs update, a state
//!   vector or image data holds it outside the JSON (see `frame.rs`), where
//!   the data channel carried it as base64.
//! - Image data comes in pieces, so a photo never holds up a note (ADR 0032,
//!   decision 7).
//! - `sync-complete` says a side has everything it asked for, so a
//!   connection counts as synced only when both have it (ADR 0031,
//!   decision 2).
//! - Pairing and heartbeats ride the same connection (ADR 0032, decisions 5
//!   and 8).
//!
//! There is still no version negotiation (ADR 0007). Devices on another
//! protocol do not find each other in the first place (ADR 0032, decision 9).

use serde::{Deserialize, Serialize};

/// The protocol this build speaks. Carried by the mDNS advert and by `pong`,
/// so a device ignores one that speaks another (ADR 0032, decision 9).
pub const PROTOCOL_VERSION: &str = "2";

/// One document as a manifest describes it. Mirrors `DocSyncEntry` (which is
/// what this device's rows look like) with the field names the wire uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub id: String,
    pub doc_type: String,
    pub title: String,
    pub title_updated_at: i64,
    pub created_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    /// When a change to `is_deleted` was last observed (ADR 0008). Optional
    /// for the same reason the reconcile rules fall back without it.
    #[serde(default)]
    pub lifecycle_updated_at: Option<i64>,
    /// Last-writer-wins on `pinned_updated_at` (ADR 0027).
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub pinned_updated_at: Option<i64>,
    /// base64 of the content hash (ADR 0033); `None` means unknown.
    pub content_hash: Option<String>,
}

/// The stamp to compare when deciding whether a tombstone or a revival is the
/// later observation, falling back through what an entry does carry.
pub fn lifecycle_stamp(entry: &ManifestEntry) -> i64 {
    entry
        .lifecycle_updated_at
        .or(entry.deleted_at)
        .unwrap_or(entry.title_updated_at)
}

/// The stamp to compare when deciding whose pin wins. Zero for a document
/// nobody has pinned.
pub fn pin_stamp(entry: &ManifestEntry) -> i64 {
    entry.pinned_updated_at.unwrap_or(0)
}

/// One image a device holds in full, as an `attach-manifest` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentEntry {
    /// Hex SHA-256 of the bytes, which is also the image's address.
    pub hash: String,
    pub mime: String,
    pub size: u64,
}

/// A message on a sync connection.
///
/// Byte fields are skipped by serde: the frame carries them after the JSON
/// header, and `payload` / `set_payload` move them in and out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Message {
    // --- whole-set reconciliation (ADR 0003) ---
    /// Every document the sender knows, tombstones included.
    SyncManifest {
        docs: Vec<ManifestEntry>,
    },
    /// "Send me what I am missing of this document"; `sv` is the asker's state
    /// vector, empty for "everything".
    SyncNeed {
        id: String,
        #[serde(skip)]
        sv: Vec<u8>,
    },
    /// The update the asker was missing.
    SyncDelta {
        id: String,
        #[serde(skip)]
        update: Vec<u8>,
    },
    /// Nothing to send: the asker is equal or ahead (ADR 0006).
    SyncNone {
        id: String,
    },
    /// The sender has decided everything it will ask for.
    SyncDone,
    /// The sender has everything it asked for.
    SyncComplete,

    // --- live changes, a latency optimisation on top ---
    DocCreated {
        entry: ManifestEntry,
    },
    DocRenamed {
        id: String,
        title: String,
        title_updated_at: i64,
    },
    DocPinned {
        id: String,
        pinned: bool,
        pinned_updated_at: i64,
    },
    DocDeleted {
        id: String,
        deleted_at: i64,
    },
    LiveUpdate {
        id: String,
        #[serde(skip)]
        update: Vec<u8>,
    },

    // --- images (ADR 0005) ---
    /// Every image the sender holds in full.
    AttachManifest {
        items: Vec<AttachmentEntry>,
    },
    AttachNeed {
        hash: String,
    },
    /// Part of an image: `data` goes at `offset` of `total` bytes.
    AttachPiece {
        hash: String,
        mime: String,
        offset: u64,
        total: u64,
        #[serde(skip)]
        data: Vec<u8>,
    },
    /// The sender does not have it (any more): stop asking this connection.
    AttachMissing {
        hash: String,
    },

    // --- the connection itself ---
    /// Sent after a quiet spell, so the other side knows the line is alive.
    Heartbeat,
    /// The first message from a device that is not paired yet (ADR 0032,
    /// decision 5). Nothing else is read from it until it is accepted.
    PairRequest {
        user_id: String,
        display_name: String,
    },
    PairAccepted {
        user_id: String,
        display_name: String,
    },
    PairDeclined,
}

impl Message {
    /// The bytes this message carries outside its JSON header, if any.
    pub fn payload(&self) -> Option<&[u8]> {
        match self {
            Message::SyncNeed { sv, .. } => Some(sv),
            Message::SyncDelta { update, .. } | Message::LiveUpdate { update, .. } => Some(update),
            Message::AttachPiece { data, .. } => Some(data),
            _ => None,
        }
    }

    /// Put back the bytes the frame carried. Refused for a message that
    /// carries none, so a frame cannot smuggle bytes into one that does not.
    pub fn set_payload(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Message::SyncNeed { sv, .. } => *sv = bytes,
            Message::SyncDelta { update, .. } | Message::LiveUpdate { update, .. } => {
                *update = bytes
            }
            Message::AttachPiece { data, .. } => *data = bytes,
            _ if bytes.is_empty() => {}
            other => return Err(format!("{} carries no bytes", other.name())),
        }
        Ok(())
    }

    /// The name on the wire, for logs.
    pub fn name(&self) -> &'static str {
        match self {
            Message::SyncManifest { .. } => "sync-manifest",
            Message::SyncNeed { .. } => "sync-need",
            Message::SyncDelta { .. } => "sync-delta",
            Message::SyncNone { .. } => "sync-none",
            Message::SyncDone => "sync-done",
            Message::SyncComplete => "sync-complete",
            Message::DocCreated { .. } => "doc-created",
            Message::DocRenamed { .. } => "doc-renamed",
            Message::DocPinned { .. } => "doc-pinned",
            Message::DocDeleted { .. } => "doc-deleted",
            Message::LiveUpdate { .. } => "live-update",
            Message::AttachManifest { .. } => "attach-manifest",
            Message::AttachNeed { .. } => "attach-need",
            Message::AttachPiece { .. } => "attach-piece",
            Message::AttachMissing { .. } => "attach-missing",
            Message::Heartbeat => "heartbeat",
            Message::PairRequest { .. } => "pair-request",
            Message::PairAccepted { .. } => "pair-accepted",
            Message::PairDeclined => "pair-declined",
        }
    }

    /// Whether this is bulk that waits behind everything else on a
    /// connection. Only image pieces are (ADR 0032, decision 7).
    pub fn is_bulk(&self) -> bool {
        matches!(self, Message::AttachPiece { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> ManifestEntry {
        ManifestEntry {
            id: "doc".into(),
            doc_type: "note".into(),
            title: "Doc".into(),
            title_updated_at: 10,
            created_at: 1,
            is_deleted: false,
            deleted_at: None,
            lifecycle_updated_at: Some(1),
            pinned: Some(true),
            pinned_updated_at: Some(5),
            content_hash: Some("abc=".into()),
        }
    }

    #[test]
    fn a_manifest_entry_uses_the_wire_names() {
        let json = serde_json::to_value(entry()).unwrap();
        for key in [
            "docType",
            "titleUpdatedAt",
            "createdAt",
            "isDeleted",
            "deletedAt",
            "lifecycleUpdatedAt",
            "pinned",
            "pinnedUpdatedAt",
            "contentHash",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn messages_are_tagged_and_their_fields_camel_cased() {
        let json = serde_json::to_value(Message::DocRenamed {
            id: "d".into(),
            title: "T".into(),
            title_updated_at: 3,
        })
        .unwrap();
        assert_eq!(json["t"], "doc-renamed");
        assert_eq!(json["titleUpdatedAt"], 3);
        assert_eq!(
            serde_json::to_value(Message::SyncComplete).unwrap()["t"],
            "sync-complete"
        );
    }

    #[test]
    fn bytes_stay_out_of_the_json() {
        let msg = Message::SyncDelta {
            id: "d".into(),
            update: vec![1, 2, 3],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"t":"sync-delta","id":"d"}"#);
    }

    #[test]
    fn a_payload_goes_back_where_it_came_from() {
        let mut msg: Message = serde_json::from_str(r#"{"t":"live-update","id":"d"}"#).unwrap();
        msg.set_payload(vec![9, 9]).unwrap();
        assert_eq!(msg.payload(), Some(&[9u8, 9][..]));
    }

    #[test]
    fn a_message_without_bytes_refuses_some() {
        let mut msg = Message::SyncDone;
        assert!(msg.set_payload(vec![]).is_ok());
        assert!(msg.set_payload(vec![1]).is_err());
    }

    #[test]
    fn stamps_fall_back_through_what_an_entry_carries() {
        let mut e = entry();
        assert_eq!(lifecycle_stamp(&e), 1);
        e.lifecycle_updated_at = None;
        e.deleted_at = Some(7);
        assert_eq!(lifecycle_stamp(&e), 7);
        e.deleted_at = None;
        assert_eq!(lifecycle_stamp(&e), 10);

        assert_eq!(pin_stamp(&e), 5);
        e.pinned_updated_at = None;
        assert_eq!(pin_stamp(&e), 0);
    }

    #[test]
    fn only_image_pieces_are_bulk() {
        assert!(Message::AttachPiece {
            hash: "h".into(),
            mime: "image/png".into(),
            offset: 0,
            total: 1,
            data: vec![0],
        }
        .is_bulk());
        assert!(!Message::SyncDone.is_bulk());
    }
}
