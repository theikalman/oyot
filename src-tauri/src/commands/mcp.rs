//! The settings page's side of MCP access (ADR 0037, decision 4).

use serde::Serialize;

#[cfg(mobile)]
const NOT_HERE: &str = "AI assistants reach Oyot on a desktop only";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    /// `off` or `read_only`.
    pub access: String,
    /// What a client launches, for the settings page to show: this binary,
    /// and `--mcp`.
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub fn get_mcp_settings(app: tauri::AppHandle) -> Result<McpSettings, String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let access = app.state::<crate::mcp::McpState>().access();
        let command = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(McpSettings {
            access: access.as_str().to_string(),
            command: command.to_string_lossy().into_owned(),
            args: vec!["--mcp".to_string()],
        })
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err(NOT_HERE.to_string())
    }
}

/// The page's answer to an `mcp-request`: a result, or an error to give the
/// assistant.
#[tauri::command]
pub fn mcp_respond(
    app: tauri::AppHandle,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<String>,
) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let answer = match error {
            Some(error) => Err(error),
            None => Ok(result.unwrap_or(serde_json::Value::Null)),
        };
        app.state::<crate::mcp::McpState>().page.respond(id, answer);
    }
    #[cfg(mobile)]
    {
        let _ = (app, id, result, error);
    }
}

/// The page is listening for `mcp-request` events, so requests can be sent.
#[tauri::command]
pub fn mcp_page_ready(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        app.state::<crate::mcp::McpState>().page.page_ready();
    }
    #[cfg(mobile)]
    {
        let _ = app;
    }
}

#[tauri::command]
pub fn set_mcp_access(app: tauri::AppHandle, access: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let access = crate::mcp::Access::parse(&access)
            .ok_or_else(|| format!("{access:?} is not a kind of access"))?;
        app.state::<crate::mcp::McpState>().set_access(&app, access)
    }
    #[cfg(mobile)]
    {
        let _ = (app, access);
        Err(NOT_HERE.to_string())
    }
}
