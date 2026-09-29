//! The tray icon (ADR 0030, decision 3).
//!
//! It is how a hidden Oyot comes back and how it quits, so it always has a
//! menu: on Linux a tray icon receives no clicks at all, and some hosts show
//! no icon without a menu. On Windows a left click also opens the window, as
//! notification-area icons do there. On macOS the icon sits in the menu bar,
//! where a click opens the menu.

use super::show_main_window;
use crate::db::AppState;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const OPEN_ID: &str = "open";
const QUIT_ID: &str = "quit";

/// How often the "Last synced" line is brought up to date.
const STATUS_INTERVAL: Duration = Duration::from_secs(60);

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Oyot", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", current_status(app), false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Oyot", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &status, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Oyot")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            QUIT_ID => app.exit(0),
            _ => {}
        });

    #[cfg(target_os = "windows")]
    {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        tray = tray
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            });
    }

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    keep_status_current(app.clone(), status);
    Ok(())
}

/// Rewrite the status line every minute, from the pair table, so it says the
/// same as the device list does.
fn keep_status_current(app: AppHandle, status: MenuItem<Wry>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(STATUS_INTERVAL).await;
            if let Err(e) = status.set_text(current_status(&app)) {
                warn_log!("[desktop] could not update the tray's sync line: {e}");
            }
        }
    });
}

fn current_status(app: &AppHandle) -> String {
    let (paired, last) = {
        let state = app.state::<AppState>();
        let db = state.db.lock();
        db.query_row(
            "SELECT COUNT(*), MAX(last_synchronized) FROM device_pairs",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .unwrap_or((0, None))
    };
    status_line(paired, last, crate::crypto::now_ms())
}

/// The tray's sync line. Worded like the device list's "last synced".
pub fn status_line(paired: i64, last_synced: Option<i64>, now: i64) -> String {
    if paired == 0 {
        return "No paired devices".to_string();
    }
    match last_synced {
        None => "Not synced yet".to_string(),
        Some(at) => format!("Last synced {}", ago(now - at)),
    }
}

/// How long ago, the way `formatLastSync` says it on the page.
fn ago(elapsed_ms: i64) -> String {
    let minutes = elapsed_ms.max(0) / 60_000;
    if minutes < 1 {
        return "just now".to_string();
    }
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn with_nothing_paired_it_says_so() {
        assert_eq!(status_line(0, None, 0), "No paired devices");
        assert_eq!(status_line(0, Some(5), 10), "No paired devices");
    }

    #[test]
    fn a_pair_that_never_synced_says_so() {
        assert_eq!(status_line(1, None, 0), "Not synced yet");
    }

    #[test]
    fn it_counts_minutes_hours_and_days() {
        let now = 1_000_000 * MIN;
        assert_eq!(
            status_line(1, Some(now - 30_000), now),
            "Last synced just now"
        );
        assert_eq!(
            status_line(1, Some(now - 5 * MIN), now),
            "Last synced 5m ago"
        );
        assert_eq!(
            status_line(1, Some(now - 3 * 60 * MIN), now),
            "Last synced 3h ago"
        );
        assert_eq!(
            status_line(2, Some(now - 49 * 60 * MIN), now),
            "Last synced 2d ago"
        );
    }

    #[test]
    fn a_stamp_from_the_future_reads_as_just_now() {
        // A peer whose clock runs ahead can leave one.
        assert_eq!(status_line(1, Some(10 * MIN), 0), "Last synced just now");
    }
}
