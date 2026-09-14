use crate::db::AppState;
use crate::identity::UserIdentity;
use crate::pairing::{self, DevicePair};

/// This device's identity, as the signaling manager holds it.
///
/// Reading it through `get_or_create_identity` meant a command could mint a
/// brand new keypair if the row were ever missing, leaving the UI showing one
/// node_id while messages went out signed with another. Startup is the only
/// thing that creates an identity; everything after reads the one it loaded.
fn local_identity(state: &AppState) -> Result<UserIdentity, String> {
    state
        .signaling_manager
        .public_identity()
        .ok_or_else(|| "identity is not loaded".to_string())
}

#[tauri::command]
pub fn get_identity(state: tauri::State<'_, AppState>) -> Result<UserIdentity, String> {
    local_identity(&state)
}

#[tauri::command]
pub fn set_display_name(
    state: tauri::State<'_, AppState>,
    display_name: String,
) -> Result<(), String> {
    {
        let db = state.db.lock();
        crate::identity::update_display_name(&db, &display_name)?;
    }
    // The manager loads the identity once at startup and puts the display
    // name in every pair request, so without this a rename was invisible to
    // peers until the app was restarted.
    state.signaling_manager.set_display_name(&display_name);
    Ok(())
}

#[tauri::command]
pub fn list_paired_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DevicePair>, String> {
    let user_id = local_identity(&state)?.user_id;
    let db = state.db.lock();
    pairing::load_pairs(&db, &user_id)
}

#[tauri::command]
pub fn remove_pair(state: tauri::State<'_, AppState>, peer_node_id: String) -> Result<(), String> {
    let user_id = local_identity(&state)?.user_id;
    {
        let db = state.db.lock();
        pairing::remove_pair(&db, &user_id, &peer_node_id)?;
    }
    // The persisted row is only half of what trusts this peer; the session
    // authorization has to go too, or its next offer is accepted anyway.
    state.signaling_manager.revoke_peer(&peer_node_id);
    Ok(())
}

#[tauri::command]
pub fn save_pair(
    state: tauri::State<'_, AppState>,
    peer_node_id: String,
    peer_display_name: String,
    room_id: String,
) -> Result<(), String> {
    let user_id = local_identity(&state)?.user_id;
    let db = state.db.lock();
    pairing::save_pair(&db, &user_id, &peer_node_id, &peer_display_name, &room_id)
}

#[tauri::command]
pub fn update_pair_sync_time(
    state: tauri::State<'_, AppState>,
    room_id: String,
) -> Result<(), String> {
    let db = state.db.lock();
    pairing::update_last_sync(&db, &room_id)
}
