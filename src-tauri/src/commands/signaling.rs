//! The listener, and the two ways another device is found: this network
//! (ADR 0018) and the addresses the user stored (ADR 0023).
//!
//! Rust starts them at launch, with the sync engine, and they run for the
//! life of the process (ADR 0031, decision 1). The page used to start them
//! when it loaded and stop them when it went, so sync stopped whenever the
//! page did. It now only reads how they stand.

use crate::db::AppState;
use crate::network::lan_signaling;
use crate::sync::manager::SyncManager;
use tauri::{AppHandle, Emitter, Manager, State};

/// Emitted once the listener and discovery are up, for a page that asked
/// before they were.
pub const NETWORK_STARTED_EVENT: &str = "network-started";

/// How the listener and discovery came up.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NetworkStatus {
    /// The port other devices connect to, or `None` when nothing could be
    /// bound. This device can still dial out then; nothing can dial in.
    pub port: Option<u16>,
    /// Whether that is the port a peer holding only a stored address assumes.
    /// When it is not, this device is reachable locally and not remotely, and
    /// the settings screen says so rather than letting it look healthy.
    pub on_default_port: bool,
    /// Why local discovery is not running, when it is not. Not the end of
    /// sync: a device with no mDNS at all - iOS, or a firewall that ate the
    /// prompt - still syncs with whatever it has an address for.
    pub discovery_error: Option<String>,
}

/// Start listening, finding and syncing: at launch on a desktop, and each
/// time a phone comes on screen (ADR 0034, decision 1). Starting what is
/// already running does nothing.
///
/// The listener comes up before the advertisement, so there is no moment when
/// a peer is invited to a port that is not accepting yet, and the engine
/// starts last, once there is somewhere for a found device to have come from.
pub async fn start_network(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let sync = app.state::<SyncManager>();
    if state.network.lock().is_some() {
        return Ok(());
    }
    let node_id = state.signaling_manager.get_node_id();
    if node_id.is_empty() {
        return Err("cannot start sync before the identity is loaded".to_string());
    }

    let inbound = state.signaling_manager.inbound(&node_id, &state.boot_id);
    let status = match lan_signaling::listen(inbound, sync.inner().clone()).await {
        Ok(listener) => {
            let port = listener.port();
            let on_default_port = listener.on_default_port();
            if let Some(previous) = state.lan_listener.lock().replace(listener) {
                previous.stop();
            }
            // A stored address names the port without being told it, so the
            // listener stays open when discovery cannot start, and the
            // failure is reported rather than raised.
            let discovery_error = state.lan.start(&node_id, &state.boot_id, port).err();
            NetworkStatus {
                port: Some(port),
                on_default_port,
                discovery_error,
            }
        }
        Err(e) => {
            warn_log!("[sync] nothing can reach this device: {e}");
            NetworkStatus {
                port: None,
                on_default_port: false,
                discovery_error: Some(e),
            }
        }
    };
    state.remote.start();
    sync.start();

    *state.network.lock() = Some(status.clone());
    let _ = app.emit(NETWORK_STARTED_EVENT, &status);
    Ok(())
}

/// Stop advertising, probing, listening and syncing, as the process exits.
pub fn stop_network(app: &AppHandle) {
    stop_listening(app);
    if let Some(sync) = app.try_state::<SyncManager>() {
        sync.stop();
    }
}

/// Stop advertising, probing and listening, and leave the connections to
/// whoever holds them: a phone leaving the screen lets a sync in progress
/// finish first (ADR 0034, decision 6).
///
/// Advertising stops first: a peer that acts on a stale advertisement should
/// find a closed port rather than an open one that no longer means anything.
pub fn stop_listening(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.lan.stop();
        state.remote.stop();
        if let Some(listener) = state.lan_listener.lock().take() {
            listener.stop();
        }
        *state.network.lock() = None;
    }
}

/// How the listener and discovery came up, or `None` before they have.
#[tauri::command]
pub fn get_network_status(state: State<'_, AppState>) -> Option<NetworkStatus> {
    state.network.lock().clone()
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
