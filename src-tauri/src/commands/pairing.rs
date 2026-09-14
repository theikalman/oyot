use crate::db::AppState;
use crate::identity::UserIdentity;
use crate::pairing::{self, DevicePair};

#[tauri::command]
pub fn get_identity(state: tauri::State<'_, AppState>) -> Result<UserIdentity, String> {
    let db = state.db.lock();
    crate::identity::get_or_create_identity(&db)
}

#[tauri::command]
pub fn set_display_name(
    state: tauri::State<'_, AppState>,
    display_name: String,
) -> Result<(), String> {
    let db = state.db.lock();
    crate::identity::update_display_name(&db, &display_name)
}

#[tauri::command]
pub fn list_paired_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DevicePair>, String> {
    let db = state.db.lock();
    let identity = crate::identity::get_or_create_identity(&db)?;
    pairing::load_pairs(&db, &identity.user_id)
}

#[tauri::command]
pub fn remove_pair(state: tauri::State<'_, AppState>, peer_node_id: String) -> Result<(), String> {
    let db = state.db.lock();
    let identity = crate::identity::get_or_create_identity(&db)?;
    pairing::remove_pair(&db, &identity.user_id, &peer_node_id)
}

#[tauri::command]
pub fn save_pair(
    state: tauri::State<'_, AppState>,
    peer_node_id: String,
    peer_display_name: String,
    room_id: String,
) -> Result<(), String> {
    let db = state.db.lock();
    let identity = crate::identity::get_or_create_identity(&db)?;
    pairing::save_pair(
        &db,
        &identity.user_id,
        &peer_node_id,
        &peer_display_name,
        &room_id,
    )
}

#[tauri::command]
pub fn update_pair_sync_time(
    state: tauri::State<'_, AppState>,
    room_id: String,
) -> Result<(), String> {
    let db = state.db.lock();
    pairing::update_last_sync(&db, &room_id)
}
