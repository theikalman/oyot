//! The sync engine, in Rust (ADR 0031, ADR 0032).
//!
//! Sync used to run in the webview, over WebRTC, and stopped whenever the
//! page did. Here it runs for the life of the process, with or without a
//! window, over one TLS connection per pair of devices:
//!
//! - `protocol`: the messages two devices exchange
//! - `frame`: how a message is put on the wire
//! - `reconcile`: what to do about one document, given another copy's word
//! - `session`: one connection's share of the exchange, sans-IO
//! - `repo`: the session's view of this device's database
//! - `events`: what the engine tells the page, when there is one
//! - `tls`: TLS 1.3 keyed by each device's node key
//! - `manager`: the connections, their lifetimes, pairing and bounded runs
//! - `tauri_events`: `events`, emitted to the page

pub mod events;
pub mod frame;
pub mod manager;
pub mod protocol;
pub mod reconcile;
pub mod repo;
pub mod session;
pub mod tauri_events;
pub mod tls;

use manager::SyncManager;
use protocol::Message;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// Tell every connected device about a change made on this one (ADR 0031,
/// decision 6). The command that made the change calls this, so there is no
/// way to change a document and forget to say so. Nothing happens before the
/// engine has started, and a device that is not connected hears of the
/// change from the next manifest exchange instead.
pub fn announce(app: &AppHandle, msg: Message) {
    if let Some(manager) = app.try_state::<SyncManager>() {
        manager.broadcast(msg);
    }
}

/// Announce a document made or revived here, as the database now has it.
pub fn announce_created(app: &AppHandle, db: &Connection, doc_id: &str) {
    if app.try_state::<SyncManager>().is_none() {
        return;
    }
    match crate::commands::documents::sync_entry(db, doc_id) {
        Ok(Some(row)) => announce(
            app,
            Message::DocCreated {
                entry: repo::manifest_entry(row),
            },
        ),
        Ok(None) => {}
        Err(e) => warn_log!("[sync] could not describe {doc_id} to peers: {e}"),
    }
}
