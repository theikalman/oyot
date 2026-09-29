//! The small pile of preferences in `config.json`.
//!
//! The broker address, its credentials and the sync mode used to live here
//! too. ADR 0022 removed all three. Their keys are left in any file that
//! already has them: an unrecognised key here has always been ignored, and
//! clearing them is a migration rather than a read.

use std::collections::BTreeMap;
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

/// Where the keyboard shortcuts the user changed are kept.
const SHORTCUTS_KEY: &str = "keyboard_shortcuts";
/// Far more than there are shortcuts to change, and few enough that what is
/// stored cannot grow without bound.
const MAX_SHORTCUTS: usize = 100;
/// A shortcut has one set of keys, or a few where its own come in several.
const MAX_KEYS_PER_SHORTCUT: usize = 4;
const MAX_NAME_LEN: usize = 40;
const MAX_KEYS_LEN: usize = 40;

/// The keyboard shortcuts the user changed on this device: for each, by its
/// name, the keys it has instead of its own, or none. Empty until one is
/// changed.
///
/// Kept per device, like the theme, because a keyboard is. Only the shape is
/// checked, here and when saving: which names and keys mean something is the
/// page's to know. It ignores what it does not recognise and keeps it, so a
/// shortcut a later version added survives a trip through an earlier one.
#[tauri::command]
pub fn get_keyboard_shortcuts(app: tauri::AppHandle) -> BTreeMap<String, Vec<String>> {
    shortcuts(&read_config(&app))
}

/// Replace the changed keyboard shortcuts. None at all removes the key, so a
/// device back on its defaults has nothing stored.
#[tauri::command]
pub fn save_keyboard_shortcuts(
    app: tauri::AppHandle,
    shortcuts: BTreeMap<String, Vec<String>>,
) -> Result<(), String> {
    check_shortcuts(&shortcuts)?;
    let mut json = read_config(&app);
    // As in write_flag: a file holding something other than an object has
    // nothing worth keeping.
    if !json.is_object() {
        json = serde_json::Value::Object(Default::default());
    }
    if shortcuts.is_empty() {
        if let Some(object) = json.as_object_mut() {
            object.remove(SHORTCUTS_KEY);
        }
    } else {
        json[SHORTCUTS_KEY] = serde_json::json!(shortcuts);
    }
    write_config(&app, json)
}

/// The shortcuts stored in `json`. An entry of the wrong shape is left out
/// rather than failing the lot: a file edited by hand should lose the entry
/// it broke, not every shortcut.
fn shortcuts(json: &serde_json::Value) -> BTreeMap<String, Vec<String>> {
    let Some(stored) = json.get(SHORTCUTS_KEY).and_then(|v| v.as_object()) else {
        return BTreeMap::new();
    };
    stored
        .iter()
        .filter_map(|(name, keys)| {
            let keys = keys
                .as_array()?
                .iter()
                .map(|k| k.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()?;
            check_entry(name, &keys).ok()?;
            Some((name.clone(), keys))
        })
        .take(MAX_SHORTCUTS)
        .collect()
}

fn check_shortcuts(shortcuts: &BTreeMap<String, Vec<String>>) -> Result<(), String> {
    if shortcuts.len() > MAX_SHORTCUTS {
        return Err("too many keyboard shortcuts".to_string());
    }
    shortcuts
        .iter()
        .try_for_each(|(name, keys)| check_entry(name, keys))
}

/// A name is a shortcut's id, letters and digits. Keys are the page's
/// notation, `Mod-Shift-k`: printable, and nothing that could lay out a line
/// or hide in one.
fn check_entry(name: &str, keys: &[String]) -> Result<(), String> {
    let good_name = !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name.bytes().all(|b| b.is_ascii_alphanumeric());
    if !good_name {
        return Err("that is not the name of a keyboard shortcut".to_string());
    }
    if keys.len() > MAX_KEYS_PER_SHORTCUT {
        return Err(format!("too many keys for the {name} shortcut"));
    }
    let good_keys = |k: &String| {
        !k.is_empty()
            && k.chars().count() <= MAX_KEYS_LEN
            && k.chars()
                .all(|c| !c.is_control() && !c.is_whitespace() && !invisible(c))
    };
    if !keys.iter().all(good_keys) {
        return Err(format!("those are not keys for the {name} shortcut"));
    }
    Ok(())
}

/// Characters that take up no room, or reorder the text around them: no key
/// types one, and on the page they could make a shortcut read as another.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
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

    use super::{check_shortcuts, shortcuts, MAX_SHORTCUTS};
    use std::collections::BTreeMap;

    fn map(entries: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        entries
            .iter()
            .map(|(name, keys)| {
                (
                    name.to_string(),
                    keys.iter().map(|k| k.to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn no_stored_shortcuts_reads_as_none_changed() {
        assert!(shortcuts(&json!({})).is_empty());
        assert!(shortcuts(&json!({ "keyboard_shortcuts": "Mod-k" })).is_empty());
        assert!(shortcuts(&json!([])).is_empty());
    }

    #[test]
    fn stored_shortcuts_read_back_as_saved() {
        let config = json!({
            "theme": "dark",
            "keyboard_shortcuts": { "bold": ["Mod-Shift-k"], "italic": [], "redo": ["Mod-y", "Mod-ö"] },
        });
        assert_eq!(
            shortcuts(&config),
            map(&[
                ("bold", &["Mod-Shift-k"]),
                ("italic", &[]),
                ("redo", &["Mod-y", "Mod-ö"]),
            ])
        );
    }

    #[test]
    fn a_broken_entry_is_left_out_and_the_rest_kept() {
        let config = json!({
            "keyboard_shortcuts": {
                "bold": ["Mod-k"],
                "italic": "Mod-i",
                "code": [1],
                "not a name": ["Mod-j"],
                "strike": ["Mod k"],
                "underline": [],
            },
        });
        assert_eq!(
            shortcuts(&config),
            map(&[("bold", &["Mod-k"]), ("underline", &[])])
        );
    }

    #[test]
    fn saving_takes_names_and_keys_of_the_right_shape() {
        assert!(check_shortcuts(&map(&[])).is_ok());
        assert!(check_shortcuts(&map(&[("bold", &["Mod-Shift-k"]), ("italic", &[])])).is_ok());
        assert!(check_shortcuts(&map(&[("heading1", &["Mod--", "Ctrl-ö"])])).is_ok());
    }

    #[test]
    fn saving_refuses_a_name_that_is_not_one() {
        assert!(check_shortcuts(&map(&[("", &["Mod-k"])])).is_err());
        assert!(check_shortcuts(&map(&[("bold face", &["Mod-k"])])).is_err());
        assert!(check_shortcuts(&map(&[("../bold", &["Mod-k"])])).is_err());
        assert!(check_shortcuts(&map(&[(&"b".repeat(41), &["Mod-k"])])).is_err());
    }

    #[test]
    fn saving_refuses_keys_that_are_not_keys() {
        assert!(check_shortcuts(&map(&[("bold", &[""])])).is_err());
        assert!(check_shortcuts(&map(&[("bold", &["Mod k"])])).is_err());
        assert!(check_shortcuts(&map(&[("bold", &["Mod-\nk"])])).is_err());
        assert!(check_shortcuts(&map(&[("bold", &["Mod-\u{202e}k"])])).is_err());
        assert!(check_shortcuts(&map(&[("bold", &[&"k".repeat(41)])])).is_err());
        assert!(check_shortcuts(&map(&[(
            "bold",
            &["Mod-a", "Mod-b", "Mod-c", "Mod-d", "Mod-e"]
        )]))
        .is_err());
    }

    #[test]
    fn saving_refuses_more_shortcuts_than_there_could_be() {
        let many: BTreeMap<String, Vec<String>> = (0..=MAX_SHORTCUTS)
            .map(|i| (format!("shortcut{i}"), vec!["Mod-k".to_string()]))
            .collect();
        assert!(check_shortcuts(&many).is_err());
    }
}
