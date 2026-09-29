//! What the page asks of the sync engine's connections (ADR 0031, decision 9).
//!
//! The engine runs whether or not a page is open. These let the one that is
//! read how each paired device stands, pair, and use the connection controls
//! the device list has always had. The ones that dial are async, so the dial
//! runs on the async runtime.

use crate::sync::events::PeerState;
use crate::sync::manager::SyncManager;
use tauri::State;

/// Every paired device's connection, for a page that has just loaded. From
/// then on it hears of each change as it happens.
#[tauri::command]
pub fn get_sync_status(sync: State<'_, SyncManager>) -> Vec<PeerState> {
    sync.status()
}

/// Ask a device to pair. Resolves once the request is on its way; the answer
/// arrives as a `signaling-pair-response-received` event.
#[tauri::command]
pub async fn request_pair(
    sync: State<'_, SyncManager>,
    peer_node_id: String,
) -> Result<(), String> {
    trace!("[cmd] request_pair peer_node_id={peer_node_id}");
    sync.request_pair(&peer_node_id).await
}

/// Answer the pair request `peer_node_id` sent. Only the node_id comes from
/// the page: who the device says it is comes from the request itself (ADR
/// 0032, decision 5).
#[tauri::command]
pub fn answer_pair_request(
    sync: State<'_, SyncManager>,
    peer_node_id: String,
    accept: bool,
) -> Result<(), String> {
    trace!("[cmd] answer_pair_request peer_node_id={peer_node_id} accept={accept}");
    sync.answer_pair(&peer_node_id, accept)
}

/// Close the connection to a device and keep it closed, across restarts,
/// until the user reconnects it (ADR 0032, decision 10).
#[tauri::command]
pub fn disconnect_device(sync: State<'_, SyncManager>, peer_node_id: String) -> Result<(), String> {
    trace!("[cmd] disconnect_device peer_node_id={peer_node_id}");
    sync.disconnect(&peer_node_id)
}

/// Dial a device now, skipping the backoff, and lift a disconnect.
#[tauri::command]
pub async fn reconnect_device(
    sync: State<'_, SyncManager>,
    peer_node_id: String,
) -> Result<(), String> {
    trace!("[cmd] reconnect_device peer_node_id={peer_node_id}");
    sync.reconnect(&peer_node_id)
}

/// Ask every connected device for an image a note embeds and this device
/// does not hold. `attachment-downloaded` says when it has arrived.
#[tauri::command]
pub fn request_attachment(sync: State<'_, SyncManager>, hash: String) {
    sync.request_attachment(&hash);
}
