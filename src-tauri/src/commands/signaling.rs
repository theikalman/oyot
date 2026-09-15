//! Commands the frontend transport calls to move signaling messages.
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
