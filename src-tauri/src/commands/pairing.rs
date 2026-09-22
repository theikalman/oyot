use crate::db::AppState;
use crate::endpoints::{self, DeviceEndpoint};
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
        // An address is only ever a way to reach a device we are paired with,
        // so it goes with the pairing. Left behind, it would keep the removed
        // device answering probes and showing up as reachable.
        endpoints::remove_endpoints_for_peer(&db, &user_id, &peer_node_id)?;
    }
    // The persisted row is only half of what trusts this peer; the session
    // authorization has to go too, or its next offer is accepted anyway.
    state.signaling_manager.revoke_peer(&peer_node_id);
    state
        .peers
        .forget(&peer_node_id, crate::network::peers::PeerSource::Address);
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

// --- addresses for devices that are not on this network -------------------

/// Store an address for a device, as typed (ADR 0023).
///
/// Returns the parsed row so the caller shows what was understood rather than
/// what was typed: "laptop.ts.net" being read as port 19701 is worth seeing.
///
/// The node_id is not checked against the pair table on purpose. An address is
/// how an unpaired device is reached in the first place, so requiring a pairing
/// first would make pairing over a stored address impossible.
#[tauri::command]
pub fn save_peer_endpoint(
    state: tauri::State<'_, AppState>,
    peer_node_id: String,
    address: String,
) -> Result<DeviceEndpoint, String> {
    let user_id = local_identity(&state)?.user_id;
    let node_id = peer_node_id.trim().to_string();
    if node_id.is_empty() {
        return Err("Which device is this address for?".to_string());
    }
    if node_id == local_identity(&state)?.node_id {
        return Err("That is this device's own id.".to_string());
    }
    let (host, port) = endpoints::parse_endpoint(&address)?;
    let now = crate::crypto::now_ms();

    {
        let db = state.db.lock();
        endpoints::save_endpoint(&db, &user_id, &node_id, &host, port, now)?;
    }
    trace!("[cmd] save_peer_endpoint {} -> {}:{}", node_id, host, port);

    Ok(DeviceEndpoint {
        peer_node_id: node_id,
        host,
        port,
        added_at: now,
        last_ok: None,
    })
}

#[tauri::command]
pub fn forget_peer_endpoint(
    state: tauri::State<'_, AppState>,
    peer_node_id: String,
    host: String,
    port: u16,
) -> Result<(), String> {
    let user_id = local_identity(&state)?.user_id;
    {
        let db = state.db.lock();
        endpoints::remove_endpoint(&db, &user_id, &peer_node_id, &host, port)?;
    }
    // The peer table still holds whatever this address last proved. Leaving it
    // there would keep offering a route the user has just deleted.
    state
        .peers
        .forget(&peer_node_id, crate::network::peers::PeerSource::Address);
    Ok(())
}

#[tauri::command]
pub fn list_peer_endpoints(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DeviceEndpoint>, String> {
    let user_id = local_identity(&state)?.user_id;
    let db = state.db.lock();
    endpoints::load_endpoints(&db, &user_id)
}
