use crate::db::AppState;

#[tauri::command]
pub fn get_attachment_path(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, String> {
    use rusqlite::params;
    let db = state.db.lock();
    let result: Option<String> = db
        .query_row(
            "SELECT local_path FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
            params![&hash],
            |row| row.get(0),
        )
        .ok();
    Ok(result)
}
