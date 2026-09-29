//! The phone's background sync settings, and the last background run
//! (ADR 0034, decisions 4 and 7).
//!
//! Two switches: "Sync in the background", on by default, and "Also on
//! mobile data", off. They are read by the run itself, which may start with
//! no Tauri app at all, so they live in `config.json` like the desktop's
//! flags. A desktop has neither: it keeps running in the tray instead (ADR
//! 0030).

use crate::commands::config::{read_flag, write_flag};
use crate::db::AppState;
use crate::sync::background::{ENABLED_KEY, MOBILE_DATA_KEY};
use crate::sync::runs::{self, RunRecord};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSync {
    /// Whether this device syncs in the background at all: a phone.
    pub supported: bool,
    pub enabled: bool,
    pub mobile_data: bool,
    /// The newest background run, for "Last background sync".
    pub last_run: Option<RunRecord>,
}

#[tauri::command]
pub fn get_background_sync(app: AppHandle, state: State<'_, AppState>) -> BackgroundSync {
    let last_run = runs::last(&state.db.lock()).unwrap_or_else(|e| {
        warn_log!("[sync] could not read the last background run: {e}");
        None
    });
    BackgroundSync {
        supported: cfg!(mobile),
        enabled: read_flag(&app, ENABLED_KEY, true),
        mobile_data: read_flag(&app, MOBILE_DATA_KEY, false),
        last_run,
    }
}

#[tauri::command]
pub fn set_background_sync(app: AppHandle, enabled: bool) -> Result<(), String> {
    only_on_a_phone()?;
    write_flag(&app, ENABLED_KEY, enabled)?;
    #[cfg(mobile)]
    crate::mobile::reschedule(&app);
    Ok(())
}

#[tauri::command]
pub fn set_background_sync_mobile_data(app: AppHandle, allowed: bool) -> Result<(), String> {
    only_on_a_phone()?;
    write_flag(&app, MOBILE_DATA_KEY, allowed)?;
    #[cfg(mobile)]
    crate::mobile::reschedule(&app);
    Ok(())
}

fn only_on_a_phone() -> Result<(), String> {
    if cfg!(mobile) {
        Ok(())
    } else {
        Err("background sync is for phones; a desktop keeps running in the tray".to_string())
    }
}
