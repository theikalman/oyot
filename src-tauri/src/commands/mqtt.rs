use crate::db::AppState;
use tauri::State;

#[tauri::command]
pub async fn mqtt_connect(
    state: State<'_, AppState>,
    broker_url: String,
) -> Result<(), String> {
    let node_id = state.signaling_manager.get_node_id();
    eprintln!("[cmd] mqtt_connect broker_url={} node_id={}", broker_url, node_id);
    let result = state.signaling_manager.connect(&broker_url, &node_id).await;
    if let Err(e) = &result {
        eprintln!("[cmd] mqtt_connect FAILED: {}", e);
    }
    result
}

#[tauri::command]
pub fn mqtt_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    eprintln!("[cmd] mqtt_disconnect");
    state.signaling_manager.disconnect();
    Ok(())
}

#[tauri::command]
pub async fn mqtt_publish_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_pair_request peer_node_id={}", peer_node_id);
    state.signaling_manager.publish_pair_request(&peer_node_id).await
}

#[tauri::command]
pub async fn mqtt_accept_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
    peer_user_id: String,
    peer_display_name: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_accept_pair_request peer_node_id={}", peer_node_id);
    state.signaling_manager.authorize_peer(&peer_node_id, &peer_user_id, &peer_display_name);
    state.signaling_manager.publish_pair_response(&peer_node_id, true).await
}

#[tauri::command]
pub async fn mqtt_decline_pair_request(
    state: State<'_, AppState>,
    peer_node_id: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_decline_pair_request peer_node_id={}", peer_node_id);
    state.signaling_manager.publish_pair_response(&peer_node_id, false).await
}

#[tauri::command]
pub async fn mqtt_publish_offer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_offer peer_id={}", peer_id);
    state.signaling_manager.publish_offer(&peer_id, &sdp).await
}

#[tauri::command]
pub async fn mqtt_publish_answer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_answer peer_id={}", peer_id);
    state.signaling_manager.publish_answer(&peer_id, &sdp).await
}

#[tauri::command]
pub async fn mqtt_publish_ice_candidate(
    state: State<'_, AppState>,
    peer_id: String,
    candidate: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_ice_candidate peer_id={}", peer_id);
    state.signaling_manager.publish_ice_candidate(&peer_id, &candidate).await
}

#[tauri::command]
pub fn get_mqtt_status(state: State<'_, AppState>) -> Result<String, String> {
    let status = state.signaling_manager.mqtt_connection_status();
    eprintln!("[cmd] get_mqtt_status -> {}", status);
    Ok(status.to_string())
}
