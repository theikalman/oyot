//! Keeping Oyot running on a desktop when its window is closed (ADR 0030).
//!
//! A desktop is the device a phone reaches when it syncs in the background
//! (ADR 0034), so it has to stay up: closing the window hides it, a tray icon
//! is how it comes back and how it quits, and it can start at login without a
//! window at all. None of this exists on a phone, where the system owns the
//! app's life cycle, so the whole module is desktop-only.

mod app_nap;
pub mod close;
pub mod tray;

use tauri::{AppHandle, Manager};

/// The page's window, the only one Oyot opens. Named in tauri.conf.json.
pub const MAIN_WINDOW: &str = "main";

/// What a login start passes, so that it starts in the tray rather than on
/// screen (ADR 0030, decision 7).
pub const HIDDEN_FLAG: &str = "--hidden";

/// Whether this run was started at login, to stay in the tray.
pub fn launched_hidden() -> bool {
    std::env::args().any(|arg| arg == HIDDEN_FLAG)
}

/// Bring the window back, from wherever it went: hidden to the tray,
/// minimised, or behind other windows.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    app_nap::end();
}

/// Hide the window and keep running. Nothing about sync changes: until ADR
/// 0031 moves the engine into Rust, the page keeps it going while hidden.
pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    app_nap::begin();
}

/// A run started at login has no window on screen, so it naps as soon as it
/// starts unless it opts out.
pub fn started_hidden() {
    app_nap::begin();
}
