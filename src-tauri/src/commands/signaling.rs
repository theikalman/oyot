//! Commands the frontend transport calls to move signaling messages.
//!
//! The publishing commands return the route that carried the message, so the
//! transport knows which one to blame when the connection that follows does
//! not come up.
//!
//! Named for signaling rather than for MQTT: which transport carries a
//! message is decided inside the manager, not by the caller. Only
//! `broker_connect` is broker-specific, because only the broker has an
//! address to configure. See ADR 0018.

use crate::db::AppState;
use tauri::State;

#[tauri::command]
pub async fn broker_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    broker_url: String,
) -> Result<(), String> {
    let node_id = state.signaling_manager.get_node_id();
    trace!(
        "[cmd] broker_connect broker_url={} node_id={}",
        broker_url,
        node_id
    );
    let credentials = {
        let stored = crate::commands::config::get_mqtt_credentials(app);
        match (stored.username, stored.password) {
            (Some(u), Some(p)) => Some((u, p)),
            // A username with no password is not something a broker accepts,
            // so treat a half-filled pair as none rather than failing to
            // connect for a reason the user cannot see.
            _ => None,
        }
    };
    let result = state
        .signaling_manager
        .connect(&broker_url, &node_id, credentials)
        .await;
    if let Err(e) = &result {
        warn_log!("[cmd] broker_connect FAILED: {}", e);
    }
    result
}

#[tauri::command]
pub async fn signaling_publish_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<String, String> {
    trace!(
        "[cmd] signaling_publish_pair_request peer_node_id={}",
        peer_node_id
    );
    state
        .signaling_manager
        .publish_pair_request(&peer_node_id)
        .await
        .map(|route| route.label().to_string())
}

#[tauri::command]
pub async fn signaling_accept_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
    peer_user_id: String,
    peer_display_name: String,
) -> Result<String, String> {
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
        .map(|route| route.label().to_string())
}

#[tauri::command]
pub async fn signaling_decline_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<String, String> {
    trace!(
        "[cmd] signaling_decline_pair_request peer_node_id={}",
        peer_node_id
    );
    state
        .signaling_manager
        .publish_pair_response(&peer_node_id, false)
        .await
        .map(|route| route.label().to_string())
}

#[tauri::command]
pub async fn signaling_publish_offer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<String, String> {
    trace!("[cmd] signaling_publish_offer peer_id={}", peer_id);
    state
        .signaling_manager
        .publish_offer(&peer_id, &sdp)
        .await
        .map(|route| route.label().to_string())
}

#[tauri::command]
pub async fn signaling_publish_answer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<String, String> {
    trace!("[cmd] signaling_publish_answer peer_id={}", peer_id);
    state
        .signaling_manager
        .publish_answer(&peer_id, &sdp)
        .await
        .map(|route| route.label().to_string())
}

#[tauri::command]
pub async fn signaling_publish_ice_candidate(
    state: State<'_, AppState>,
    peer_id: String,
    candidate: String,
) -> Result<String, String> {
    trace!("[cmd] signaling_publish_ice_candidate peer_id={}", peer_id);
    state
        .signaling_manager
        .publish_ice_candidate(&peer_id, &candidate)
        .await
        .map(|route| route.label().to_string())
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

/// Report that a connection attempted over the local network did not come up.
///
/// The transport calls this when a negotiation it started locally stalls. A
/// send that fails outright is noticed inside the manager; this covers the
/// case where the message was taken but the connection never formed, which no
/// amount of watching the socket would reveal.
#[tauri::command]
pub fn signaling_note_route_failure(state: State<'_, AppState>, peer_node_id: String) {
    trace!(
        "[cmd] signaling_note_route_failure peer_node_id={}",
        peer_node_id
    );
    state.signaling_manager.note_lan_failure(&peer_node_id);
}

/// Let the local network be tried again for this peer straight away.
#[tauri::command]
pub fn signaling_clear_route_failure(state: State<'_, AppState>, peer_node_id: String) {
    state.signaling_manager.clear_lan_failure(&peer_node_id);
}
