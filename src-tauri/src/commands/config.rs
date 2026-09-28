//! The small pile of preferences in `config.json`.
//!
//! The broker address, its credentials and the sync mode used to live here
//! too. ADR 0022 removed all three. Their keys are left in any file that
//! already has them: an unrecognised key here has always been ignored, and
//! clearing them is a migration rather than a read.

use std::path::Path;
use tauri::Manager;

fn read_config(app: &tauri::AppHandle) -> serde_json::Value {
    match app.path().app_data_dir() {
        Ok(dir) => read_config_at(&dir),
        Err(_) => serde_json::Value::Object(Default::default()),
    }
}

/// The file in a data directory, for a phone's background run, which has a
/// data directory and no Tauri app to find it through (ADR 0034).
fn read_config_at(data_dir: &Path) -> serde_json::Value {
    let content = match std::fs::read_to_string(data_dir.join("config.json")).ok() {
        Some(c) => c,
        None => return serde_json::Value::Object(Default::default()),
    };
    serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
}

fn write_config(app: &tauri::AppHandle, json: serde_json::Value) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let config_path = app_data_dir.join("config.json");
    std::fs::write(config_path, json.to_string()).map_err(|e| e.to_string())
}

/// A yes-or-no preference, or `default` when it was never set.
pub(crate) fn read_flag(app: &tauri::AppHandle, key: &str, default: bool) -> bool {
    flag(&read_config(app), key, default)
}

/// `read_flag`, from a data directory.
pub(crate) fn read_flag_at(data_dir: &Path, key: &str, default: bool) -> bool {
    flag(&read_config_at(data_dir), key, default)
}

pub(crate) fn write_flag(app: &tauri::AppHandle, key: &str, value: bool) -> Result<(), String> {
    let mut json = read_config(app);
    // A file holding something other than an object would make the assignment
    // below panic; it has nothing worth keeping, so it starts again.
    if !json.is_object() {
        json = serde_json::Value::Object(Default::default());
    }
    json[key] = serde_json::json!(value);
    write_config(app, json)
}

/// `key` read as a boolean. Missing, or anything that is not a boolean, is
/// `default`: a hand-edited file should not change a behaviour by accident.
fn flag(json: &serde_json::Value, key: &str, default: bool) -> bool {
    json.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// The stored theme, or `None` when the user has never chosen one.
///
/// Defaulting to "light" here made "never chosen" and "chose light"
/// indistinguishable, so the device's own preference could never be honoured
/// on a first run.
#[tauri::command]
pub fn get_theme(app: tauri::AppHandle) -> Option<String> {
    let json = read_config(&app);
    json.get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "light" || *s == "dark")
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn save_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    if theme != "light" && theme != "dark" {
        return Err(format!("Invalid theme: {}", theme));
    }
    let mut json = read_config(&app);
    json["theme"] = serde_json::json!(theme);
    write_config(&app, json)
}

#[cfg(test)]
mod tests {
    use super::flag;
    use serde_json::json;

    #[test]
    fn a_missing_flag_reads_as_its_default() {
        assert!(flag(&json!({}), "keep_running_on_close", true));
        assert!(!flag(&json!({}), "close_notice_seen", false));
    }

    #[test]
    fn a_stored_flag_wins_over_the_default() {
        let config = json!({ "keep_running_on_close": false, "close_notice_seen": true });
        assert!(!flag(&config, "keep_running_on_close", true));
        assert!(flag(&config, "close_notice_seen", false));
    }

    #[test]
    fn a_flag_that_is_not_a_boolean_reads_as_its_default() {
        let config = json!({ "keep_running_on_close": "no", "close_notice_seen": 1 });
        assert!(flag(&config, "keep_running_on_close", true));
        assert!(!flag(&config, "close_notice_seen", false));
    }

    #[test]
    fn a_file_that_is_not_an_object_reads_as_defaults() {
        assert!(flag(&json!([]), "keep_running_on_close", true));
    }
}
