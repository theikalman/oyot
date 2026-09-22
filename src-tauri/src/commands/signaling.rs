//! Commands the frontend transport calls to move signaling messages.
//!
//! Named for signaling rather than for the transport under it. There is one
//! transport since ADR 0022, and the publishing commands no longer report
//! which one carried a message, because there is only one answer.
//!
//! A publish fails when the peer has not been found on this network. That is
//! the whole of "unreachable" now, so the error says it in those words rather
//! than naming a route.

use crate::db::AppState;
use tauri::State;

#[tauri::command]
pub async fn signaling_publish_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<(), String> {
    trace!(
        "[cmd] signaling_publish_pair_request peer_node_id={}",
        peer_node_id
    );
    state
        .signaling_manager
        .publish_pair_request(&peer_node_id)
        .await
}

#[tauri::command]
pub async fn signaling_accept_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
    peer_user_id: String,
    peer_display_name: String,
) -> Result<(), String> {
    trace!(
        "[cmd] signaling_accept_pair_request peer_node_id={}",
        peer_node_id
    );
    state
        .signaling_manager
        .authorize_peer(&peer_node_id, &peer_user_id, &peer_display_name);
    state
        .signaling_manager
        .publish_pair_response(&peer_node_id, true)
        .await
}

#[tauri::command]
pub async fn signaling_decline_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<(), String> {
    trace!(
        "[cmd] signaling_decline_pair_request peer_node_id={}",
        peer_node_id
    );
    state
        .signaling_manager
        .publish_pair_response(&peer_node_id, false)
        .await
}

#[tauri::command]
pub async fn signaling_publish_offer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<(), String> {
    trace!("[cmd] signaling_publish_offer peer_id={}", peer_id);
    state.signaling_manager.publish_offer(&peer_id, &sdp).await
}

#[tauri::command]
pub async fn signaling_publish_answer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<(), String> {
    trace!("[cmd] signaling_publish_answer peer_id={}", peer_id);
    state.signaling_manager.publish_answer(&peer_id, &sdp).await
}

#[tauri::command]
pub async fn signaling_publish_ice_candidate(
    state: State<'_, AppState>,
    peer_id: String,
    candidate: String,
) -> Result<(), String> {
    trace!("[cmd] signaling_publish_ice_candidate peer_id={}", peer_id);
    state
        .signaling_manager
        .publish_ice_candidate(&peer_id, &candidate)
        .await
}

// --- the local network ----------------------------------------------------

/// Start listening for signaling on this network, and advertise that we are.
///
/// Returns the port peers are told to connect back to, which is useful in a
/// log and is how a caller can tell a restart from a no-op.
///
/// The listener comes up before the advertisement, so there is no moment where
/// a peer is invited to a port that is not accepting yet.
#[tauri::command]
pub async fn lan_start(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<u16, String> {
    let node_id = state.signaling_manager.get_node_id();
    if node_id.is_empty() {
        return Err("cannot start local-network sync before the identity is loaded".to_string());
    }
    trace!("[cmd] lan_start node_id={}", node_id);

    let inbound = state.signaling_manager.inbound(app, &node_id);
    let listener = crate::network::lan_signaling::listen(inbound).await?;
    let port = listener.port();

    if let Some(previous) = state.lan_listener.lock().replace(listener) {
        previous.stop();
    }

    if let Err(e) = state.lan.start(&node_id, &state.boot_id, port) {
        // Nothing can reach the port we just bound, so do not leave it open.
        if let Some(listener) = state.lan_listener.lock().take() {
            listener.stop();
        }
        return Err(e);
    }

    Ok(port)
}

/// Stop advertising and stop listening.
///
/// Advertising stops first: a peer that acts on a stale advertisement should
/// find a closed port rather than an open one that no longer means anything.
#[tauri::command]
pub fn lan_stop(state: State<'_, AppState>) {
    trace!("[cmd] lan_stop");
    state.lan.stop();
    if let Some(listener) = state.lan_listener.lock().take() {
        listener.stop();
    }
}

/// The devices visible on this network right now.
#[tauri::command]
pub fn lan_list_peers(state: State<'_, AppState>) -> Vec<crate::network::lan_discovery::LanPeer> {
    state.lan.peers()
}
