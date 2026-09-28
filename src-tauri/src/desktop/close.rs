//! What closing the main window does (ADR 0030, decisions 1, 2 and 5).
//!
//! Closing goes through the page, then Rust. Rust always cancels the native
//! close and asks the page, which saves whatever the editor has pending,
//! shows the first-close notice when it is due, and then tells Rust how to
//! finish: hide, quit, or whatever the setting says.
//!
//! The page answers each request as soon as it arrives. If no answer comes
//! within `ACK_TIMEOUT`, Rust finishes on its own, so a hung or half-loaded
//! page cannot make the window impossible to close. The wait covers only that
//! answer, never the time someone spends reading the notice.
//!
//! The page does not use Tauri's own `onCloseRequested` for this. Tauri hands
//! the close to any page listening for that event, and the JavaScript API
//! destroys the window when the listener returns unless it prevents it, which
//! is how a hide in Rust used to turn into a destroyed window, and the sync
//! engine inside it with it.

use super::{hide_main_window, MAIN_WINDOW};
use crate::commands::config::read_flag;
use parking_lot::Mutex;
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// The event the page is sent when the window's close button is pressed. Its
/// payload is the request's number, which the page echoes back.
pub const CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";

/// "Keep Oyot running when the window is closed". On unless turned off.
pub const KEEP_RUNNING_KEY: &str = "keep_running_on_close";
pub const KEEP_RUNNING_DEFAULT: bool = true;

/// Whether the first-close notice has been answered.
pub const NOTICE_SEEN_KEY: &str = "close_notice_seen";

/// How long the page has to answer a close request before Rust stops waiting
/// for it.
const ACK_TIMEOUT: Duration = Duration::from_secs(3);

/// The close request waiting for the page to answer it, if one is.
#[derive(Default)]
pub struct CloseState {
    waiting: Mutex<Option<u64>>,
    last: AtomicU64,
}

/// How the page asks for a close to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Hide the window and keep running.
    Hide,
    /// Quit.
    Quit,
    /// Whichever the setting says.
    Default,
}

/// What a close actually does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Hide,
    Quit,
}

/// A close request's outcome, given the "keep running" setting.
pub fn resolve(action: CloseAction, keep_running: bool) -> Outcome {
    match action {
        CloseAction::Hide => Outcome::Hide,
        CloseAction::Quit => Outcome::Quit,
        CloseAction::Default if keep_running => Outcome::Hide,
        CloseAction::Default => Outcome::Quit,
    }
}

/// Registered with the builder for every window event.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        request(window.app_handle());
    }
}

/// Ask the page to close, and stop waiting for it after `ACK_TIMEOUT`.
fn request(app: &AppHandle) {
    let state = app.state::<CloseState>();
    let id = state.last.fetch_add(1, Ordering::SeqCst) + 1;
    *state.waiting.lock() = Some(id);

    if let Err(e) = app.emit_to(MAIN_WINDOW, CLOSE_REQUESTED_EVENT, id) {
        warn_log!("[desktop] could not ask the page to close: {e}");
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACK_TIMEOUT).await;
        let unanswered = {
            let state = app.state::<CloseState>();
            let mut waiting = state.waiting.lock();
            if *waiting == Some(id) {
                *waiting = None;
                true
            } else {
                false
            }
        };
        if unanswered {
            warn_log!("[desktop] the page did not answer close request {id}, closing without it");
            finish(&app, CloseAction::Default);
        }
    });
}

/// The page heard close request `id`. Rust stops the clock on it.
pub fn acknowledge(app: &AppHandle, id: u64) {
    let state = app.state::<CloseState>();
    let mut waiting = state.waiting.lock();
    if *waiting == Some(id) {
        *waiting = None;
    }
}

/// End a close the way the page asked.
pub fn finish(app: &AppHandle, action: CloseAction) {
    let keep_running = read_flag(app, KEEP_RUNNING_KEY, KEEP_RUNNING_DEFAULT);
    match resolve(action, keep_running) {
        Outcome::Hide => hide_main_window(app),
        Outcome::Quit => app.exit(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_hide_or_quit_ignores_the_setting() {
        for keep in [true, false] {
            assert_eq!(resolve(CloseAction::Hide, keep), Outcome::Hide);
            assert_eq!(resolve(CloseAction::Quit, keep), Outcome::Quit);
        }
    }

    #[test]
    fn the_default_follows_the_setting() {
        assert_eq!(resolve(CloseAction::Default, true), Outcome::Hide);
        assert_eq!(resolve(CloseAction::Default, false), Outcome::Quit);
    }

    #[test]
    fn the_page_names_its_actions_in_lower_case() {
        let parsed: Vec<CloseAction> =
            serde_json::from_str(r#"["hide", "quit", "default"]"#).unwrap();
        assert_eq!(
            parsed,
            [CloseAction::Hide, CloseAction::Quit, CloseAction::Default]
        );
    }
}
