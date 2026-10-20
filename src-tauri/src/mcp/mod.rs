//! Letting an MCP client, such as Claude Desktop, read notes (ADR 0037).
//!
//! The client launches this binary as `oyot --mcp`, which is the bridge: it
//! connects to the running app over a socket only this user can open and
//! copies bytes between that and its stdio. The protocol and every tool live
//! here in the app, so nothing but the app ever opens the database.
//!
//! The app always listens, whatever the setting says. With access off it
//! lists no tools and refuses every call, which is what lets the bridge tell
//! "Oyot is off" from "Oyot is not running": only the second has nothing
//! listening, and only the second is a reason to start the app.

pub mod access;
pub mod bridge;
pub mod endpoint;
mod imagesize;
mod listener;
mod notes;
pub mod page;
mod server;
#[cfg(test)]
mod tests;
mod tools;
mod writes;

use crate::db::AppState;
use crate::sync::manager::SyncManager;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub use access::Access;

/// The server's state while the app runs: the access setting as last read,
/// and the listener while one is up.
pub struct McpState {
    access: Arc<access::Current>,
    listener: parking_lot::Mutex<Option<listener::Listener>>,
    /// Requests waiting on the page.
    pub page: Arc<page::PageRelay>,
}

impl McpState {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            access: Arc::new(access::Current::new(access::read(app))),
            listener: parking_lot::Mutex::new(None),
            page: Arc::new(page::PageRelay::new(app.clone())),
        }
    }

    pub fn access(&self) -> Access {
        self.access.get()
    }

    /// How many clients are connected now.
    pub fn clients(&self) -> usize {
        self.listener.lock().as_ref().map_or(0, |l| l.connected())
    }

    /// Change the setting, and drop every connected client, so none keeps
    /// what the old setting allowed (ADR 0037, decision 4). A client that
    /// reconnects gets the tools the new setting allows.
    pub fn set_access(&self, app: &AppHandle, access: Access) -> Result<(), String> {
        access::write(app, access)?;
        self.access.set(access);
        if let Some(listener) = self.listener.lock().as_ref() {
            listener.drop_sessions();
        }
        Ok(())
    }
}

/// Start listening. A failure is logged and left at that: the app works
/// without it, and the bridge says Oyot could not be reached.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mcp = app.state::<McpState>();
    let sync_app = app.clone();
    let ctx = Arc::new(tools::Context {
        db: state.db.clone(),
        access: mcp.access.clone(),
        data_dir: state.data_dir.clone(),
        page: mcp.page.clone(),
        fetch_attachment: Arc::new(move |hash| {
            if let Some(sync) = sync_app.try_state::<SyncManager>() {
                sync.request_attachment(hash);
            }
        }),
    });
    let endpoint = endpoint::Endpoint::in_dir(&state.data_dir);
    if let Some(expected) = endpoint::Endpoint::for_this_user() {
        if expected != endpoint {
            warn_log!(
                "[mcp] the bridge will look for {expected:?}, but the app listens at {endpoint:?}"
            );
        }
    }
    match listener::Listener::start(endpoint, ctx) {
        Ok(listener) => *mcp.listener.lock() = Some(listener),
        Err(e) => warn_log!("[mcp] could not listen: {e}"),
    }
}

/// Stop listening, removing the socket, when the app exits.
pub fn stop(app: &AppHandle) {
    if let Some(mcp) = app.try_state::<McpState>() {
        if let Some(listener) = mcp.listener.lock().take() {
            listener.stop();
        }
    }
}
