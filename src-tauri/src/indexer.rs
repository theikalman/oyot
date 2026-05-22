use crate::crdt::CrdtDocument;
use rusqlite::params;

pub fn update_document_index(
    db: &rusqlite::Connection,
    doc_id: &str,
    crdt_state: &[u8],
) -> Result<(), String> {
    let mut doc = CrdtDocument::new();
    if !crdt_state.is_empty() {
        doc.load_from_state(crdt_state)?;
    }

    let metadata = doc.get_metadata();

    db.execute(
        "INSERT OR REPLACE INTO document_index (document_id, title, todo_count, completed_todo_count) VALUES (?, ?, ?, ?)",
        params![
            doc_id,
            &metadata.title,
            metadata.todo_count,
            metadata.completed_todo_count
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
