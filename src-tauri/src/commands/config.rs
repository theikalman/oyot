use tauri::Manager;

fn read_config(app: &tauri::AppHandle) -> serde_json::Value {
    let config_path = match app.path().app_data_dir() {
        Ok(dir) => dir.join("config.json"),
        Err(_) => return serde_json::Value::Object(Default::default()),
    };
    let content = match std::fs::read_to_string(config_path).ok() {
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

#[tauri::command]
pub fn get_mqtt_broker_url(app: tauri::AppHandle) -> Option<String> {
    let json = read_config(&app);
    json.get("mqtt_broker_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Rejects a URL the client could not connect with, rather than storing it and
/// leaving the user to work out why nothing happens.
#[tauri::command]
pub fn save_mqtt_broker_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    crate::network::mqtt_client::parse_broker_url(&url)?;
    let mut json = read_config(&app);
    json["mqtt_broker_url"] = serde_json::json!(url);
    write_config(&app, json)
}

/// Broker credentials, for a broker that requires authentication.
///
/// Kept as separate fields rather than embedded in the URL: a password in a
/// URL ends up in every log line that prints the URL, and it makes parsing
/// host and port ambiguous. Stored in the same plaintext `config.json` as
/// everything else, which is the same posture as the signing key and is
/// documented as such.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct BrokerCredentials {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[tauri::command]
pub fn get_mqtt_credentials(app: tauri::AppHandle) -> BrokerCredentials {
    let json = read_config(&app);
    let read = |key: &str| {
        json.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    BrokerCredentials {
        username: read("mqtt_username"),
        password: read("mqtt_password"),
    }
}

#[tauri::command]
pub fn save_mqtt_credentials(
    app: tauri::AppHandle,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let mut json = read_config(&app);
    // An empty field means "no credentials", so it clears rather than storing
    // an empty username the broker would reject.
    json["mqtt_username"] = serde_json::json!(username.filter(|s| !s.trim().is_empty()));
    json["mqtt_password"] = serde_json::json!(password.filter(|s| !s.is_empty()));
    write_config(&app, json)
}
