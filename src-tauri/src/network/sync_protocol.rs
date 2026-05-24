use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SyncMessage {
    Handshake {
        protocol_version: u32,
    },
    RequestDoc {
        doc_id: String,
        state_vector: Vec<u8>,
    },
    SendDocDelta {
        doc_id: String,
        delta: Vec<u8>,
    },
    /// Bulk update response used during QUIC catch-up sync.
    /// Contains all raw Yjs update blobs for a document in insertion order.
    SendDocUpdates {
        doc_id: String,
        updates: Vec<Vec<u8>>,
    },
    DocSyncComplete {
        doc_id: String,
    },
    RequestBlob {
        hash: String,
    },
    SendBlob {
        hash: String,
        data: Vec<u8>,
        mime_type: String,
    },
    BlobReceived {
        hash: String,
    },
}

impl SyncMessage {
    pub fn encode(&self) -> Vec<u8> {
        bincode::serialize(self).unwrap_or_default()
    }

    pub fn decode(data: &[u8]) -> Result<Self, String> {
        bincode::deserialize(data).map_err(|e| format!("Failed to decode message: {}", e))
    }
}
