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
pub async fn mqtt_publish_offer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
    from: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_offer peer_id={} from={}", peer_id, from);
    state.signaling_manager.publish_offer(&peer_id, &sdp, &from).await
}

#[tauri::command]
pub async fn mqtt_publish_answer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
    from: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_answer peer_id={} from={}", peer_id, from);
    state.signaling_manager.publish_answer(&peer_id, &sdp, &from).await
}

#[tauri::command]
pub async fn mqtt_publish_ice_candidate(
    state: State<'_, AppState>,
    peer_id: String,
    candidate: String,
    from: String,
) -> Result<(), String> {
    eprintln!("[cmd] mqtt_publish_ice_candidate peer_id={} from={}", peer_id, from);
    state.signaling_manager.publish_ice_candidate(&peer_id, &candidate, &from).await
}

#[tauri::command]
pub fn get_mqtt_status(state: State<'_, AppState>) -> Result<String, String> {
    let status = if state.signaling_manager.is_connected() {
        "connected".to_string()
    } else {
        "disconnected".to_string()
    };
    eprintln!("[cmd] get_mqtt_status -> {}", status);
    Ok(status)
}