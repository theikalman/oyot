use rusqlite::params;

pub fn update_document_index(
    db: &rusqlite::Connection,
    doc_id: &str,
    title: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
        params![doc_id, title],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
