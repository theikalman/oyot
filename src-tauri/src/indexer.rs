use rusqlite::params;

pub fn update_document_index(
    db: &rusqlite::Connection,
    doc_id: &str,
    _crdt_state: &[u8],
) -> Result<(), String> {
    // Resolve title from the documents table (managed by update_document / create_document).
    // Todo counts cannot be extracted from Yjs XmlFragment on the Rust side, so they are
    // reset to 0 here. The frontend is responsible for keeping the title column up to date.
    let title: String = db
        .query_row(
            "SELECT COALESCE(title, 'Untitled') FROM documents WHERE id = ?",
            params![doc_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "Untitled".to_string());

    db.execute(
        "INSERT OR REPLACE INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, 0, 0)",
        params![doc_id, &title],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
