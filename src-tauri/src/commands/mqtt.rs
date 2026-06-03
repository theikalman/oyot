use crate::db::AppState;
use tauri::State;

#[tauri::command]
pub async fn mqtt_connect(
    state: State<'_, AppState>,
    broker_url: String,
) -> Result<(), String> {
    let node_id = state.signaling_manager.get_node_id();
    state.signaling_manager.connect(&broker_url, &node_id).await
}

#[tauri::command]
pub fn mqtt_disconnect(state: State<'_, AppState>) -> Result<(), String> {
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
    state.signaling_manager.publish_offer(&peer_id, &sdp, &from).await
}

#[tauri::command]
pub async fn mqtt_publish_answer(
    state: State<'_, AppState>,
    peer_id: String,
    sdp: String,
    from: String,
) -> Result<(), String> {
    state.signaling_manager.publish_answer(&peer_id, &sdp, &from).await
}

#[tauri::command]
pub async fn mqtt_publish_ice_candidate(
    state: State<'_, AppState>,
    peer_id: String,
    candidate: String,
    from: String,
) -> Result<(), String> {
    state.signaling_manager.publish_ice_candidate(&peer_id, &candidate, &from).await
}

#[tauri::command]
pub fn get_mqtt_status(state: State<'_, AppState>) -> Result<String, String> {
    if state.signaling_manager.is_connected() {
        Ok("connected".to_string())
    } else {
        Ok("disconnected".to_string())
    }
}