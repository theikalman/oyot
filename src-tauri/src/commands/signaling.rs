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

// --- starting and stopping the ways a peer is found -----------------------

/// What starting signaling came up as.
#[derive(Debug, serde::Serialize)]
pub struct SignalingStarted {
    /// The port peers on this network are told to connect back to.
    pub port: u16,
    /// Whether that is the port a peer holding only a stored address assumes.
    /// When it is not, this device is reachable locally and not remotely, and
    /// the settings screen says so rather than letting it look healthy.
    pub on_default_port: bool,
    /// Why local discovery is not running, when it is not. Not an error for
    /// the whole call: since ADR 0023 a device with no mDNS at all - iOS, or a
    /// firewall that ate the prompt - still syncs with whatever it has an
    /// address for.
    pub discovery_error: Option<String>,
}

/// Start listening for signaling, and start both ways of finding a peer.
///
/// The listener comes up before the advertisement, so there is no moment where
/// a peer is invited to a port that is not accepting yet.
#[tauri::command]
pub async fn signaling_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<SignalingStarted, String> {
    let node_id = state.signaling_manager.get_node_id();
    if node_id.is_empty() {
        return Err("cannot start sync before the identity is loaded".to_string());
    }
    trace!("[cmd] signaling_start node_id={}", node_id);

    let inbound = state
        .signaling_manager
        .inbound(app, &node_id, &state.boot_id);
    let listener = crate::network::lan_signaling::listen(inbound).await?;
    let port = listener.port();
    let on_default_port = listener.on_default_port();

    if let Some(previous) = state.lan_listener.lock().replace(listener) {
        previous.stop();
    }

    // Discovery failing used to close the listener again, because a port
    // nothing could be told about was of no use to anyone. A stored address
    // names the port without being told, so the listener stays open and the
    // failure is reported rather than raised.
    let discovery_error = state.lan.start(&node_id, &state.boot_id, port).err();
    state.remote.start();

    Ok(SignalingStarted {
        port,
        on_default_port,
        discovery_error,
    })
}

/// Stop advertising, stop probing, and stop listening.
///
/// Advertising stops first: a peer that acts on a stale advertisement should
/// find a closed port rather than an open one that no longer means anything.
#[tauri::command]
pub fn signaling_stop(state: State<'_, AppState>) {
    trace!("[cmd] signaling_stop");
    state.lan.stop();
    state.remote.stop();
    if let Some(listener) = state.lan_listener.lock().take() {
        listener.stop();
    }
}

/// Try every stored address now rather than at the next interval.
#[tauri::command]
pub fn probe_stored_addresses(state: State<'_, AppState>) {
    trace!("[cmd] probe_stored_addresses");
    state.remote.probe_now();
}

/// Every device this one can reach right now, by whichever route found it.
#[tauri::command]
pub fn list_reachable_peers(state: State<'_, AppState>) -> Vec<crate::network::peers::Peer> {
    state.peers.all()
}
