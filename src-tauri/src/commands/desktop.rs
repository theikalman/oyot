//! Commands for keeping a desktop running with its window closed (ADR 0030).
//!
//! They exist on every platform, so the page's command list does not depend on
//! where it runs. On a phone, where the system decides when the app runs,
//! `get_desktop_settings` says none of this is supported and the rest refuse.

use serde::Serialize;

#[cfg(desktop)]
use crate::commands::config::{read_flag, write_flag};
#[cfg(desktop)]
use crate::desktop::close::{
    self, CloseAction, KEEP_RUNNING_DEFAULT, KEEP_RUNNING_KEY, NOTICE_SEEN_KEY,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

#[cfg(mobile)]
const NOT_HERE: &str = "This is only available on a computer.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    /// False on a phone, which has no window to close and no login to start at.
    pub supported: bool,
    /// "Keep Oyot running when the window is closed".
    pub keep_running: bool,
    /// "Start Oyot when you log in", as the OS has it registered.
    pub start_at_login: bool,
    /// Whether the first-close notice has been answered.
    pub close_notice_seen: bool,
}

#[tauri::command]
pub fn get_desktop_settings(app: tauri::AppHandle) -> DesktopSettings {
    #[cfg(desktop)]
    {
        DesktopSettings {
            supported: true,
            keep_running: read_flag(&app, KEEP_RUNNING_KEY, KEEP_RUNNING_DEFAULT),
            start_at_login: app.autolaunch().is_enabled().unwrap_or_else(|e| {
                warn_log!("[desktop] could not read the login item: {e}");
                false
            }),
            close_notice_seen: read_flag(&app, NOTICE_SEEN_KEY, false),
        }
    }
    #[cfg(mobile)]
    {
        let _ = app;
        DesktopSettings {
            supported: false,
            keep_running: false,
            start_at_login: false,
            close_notice_seen: true,
        }
    }
}

#[tauri::command]
pub fn set_keep_running(app: tauri::AppHandle, keep_running: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        write_flag(&app, KEEP_RUNNING_KEY, keep_running)
    }
    #[cfg(mobile)]
    {
        let _ = (app, keep_running);
        Err(NOT_HERE.to_string())
    }
}

/// Register or unregister the login start, and report what the OS now has, which
/// is what the settings page shows.
#[tauri::command]
pub fn set_start_at_login(app: tauri::AppHandle, start: bool) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        let launcher = app.autolaunch();
        let result = if start {
            launcher.enable()
        } else {
            launcher.disable()
        };
        result.map_err(|e| format!("Could not change the login item: {e}"))?;
        launcher.is_enabled().map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (app, start);
        Err(NOT_HERE.to_string())
    }
}

/// The first-close notice was answered. "Keep running" leaves the setting on;
/// "Quit instead" turns it off. Either way the notice is not shown again.
#[tauri::command]
pub fn answer_close_notice(app: tauri::AppHandle, keep_running: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        write_flag(&app, KEEP_RUNNING_KEY, keep_running)?;
        write_flag(&app, NOTICE_SEEN_KEY, true)
    }
    #[cfg(mobile)]
    {
        let _ = (app, keep_running);
        Err(NOT_HERE.to_string())
    }
}

/// The page heard close request `id`.
#[tauri::command]
pub fn close_acknowledged(app: tauri::AppHandle, id: u64) {
    #[cfg(desktop)]
    close::acknowledge(&app, id);
    #[cfg(mobile)]
    let _ = (app, id);
}

/// The page is done with a close request: hide, quit, or follow the setting.
#[cfg(desktop)]
#[tauri::command]
pub fn finish_close(app: tauri::AppHandle, action: CloseAction) {
    close::finish(&app, action);
}

#[cfg(mobile)]
#[tauri::command]
pub fn finish_close(app: tauri::AppHandle, action: String) {
    let _ = (app, action);
}
