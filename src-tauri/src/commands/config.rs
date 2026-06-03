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

#[tauri::command]
pub fn get_theme(app: tauri::AppHandle) -> String {
    let json = read_config(&app);
    json.get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "light" || *s == "dark")
        .unwrap_or("light")
        .to_string()
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
pub fn get_signaling_url(app: tauri::AppHandle) -> Option<String> {
    let json = read_config(&app);
    json.get("signaling_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn save_signaling_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let mut json = read_config(&app);
    json["signaling_url"] = serde_json::json!(url);
    write_config(&app, json)
}

#[tauri::command]
pub fn get_mqtt_broker_url(app: tauri::AppHandle) -> Option<String> {
    let json = read_config(&app);
    json.get("mqtt_broker_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[tauri::command]
pub fn save_mqtt_broker_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let mut json = read_config(&app);
    json["mqtt_broker_url"] = serde_json::json!(url);
    write_config(&app, json)
}
