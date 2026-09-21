//! Derived views of document content: todo counts, the link graph, and the
//! search index.
//!
//! None of this is derivable from SQL. Content lives in the CRDT blob, so the
//! editor extracts it on save (see src/lib/editor/documentIndex.ts) and hands
//! it here. Before this existed, `todo_count` was written as a literal 0,
//! `get_backlinks` had no edge table and returned every document, and search
//! could only match titles.

use rusqlite::{params, OptionalExtension};

/// One task item, as it arrives over IPC.
///
/// No id: an item is addressed by where it falls among the document's task
/// items, which is the order this vector is in. The ordinal is therefore
/// derived on insert rather than sent, so the stored order cannot disagree
/// with the walk that produced it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoInput {
    pub text: String,
    pub checked: bool,
    pub depth: i64,
}

/// What the editor extracted from a document, as it arrives over IPC.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexInput {
    pub text: String,
    pub link_targets: Vec<String>,
    /// Content hashes of the images this document embeds.
    #[serde(default)]
    pub attachment_hashes: Vec<String>,
    /// The tags this document carries, already normalized by the extractor.
    /// Defaulted so a payload from a build that predates tags still
    /// deserialises.
    #[serde(default)]
    pub tags: Vec<String>,
    pub todo_count: i32,
    pub completed_todo_count: i32,
    /// Every task item in the document, in document order. Defaulted so a
    /// payload from a build that predates the todo index still deserialises.
    #[serde(default)]
    pub todos: Vec<TodoInput>,
}

/// What a fully-built index looks like today.
///
/// Stamped on every document `update_document_index` touches, and compared
/// before collecting unreferenced attachments: a document indexed by an older
/// version has no attachment rows, and deleting blobs on the strength of that
/// would throw away images that are still on the page. Bump it whenever the
/// derived rows gain something that has to be backfilled.
///
/// v2 added `document_todos`. The bump is what makes the startup backfill
/// re-render every document with content, which is the only way a todo
/// written before this existed reaches the index page.
///
/// Not bumped for tags: a tag is a node type no earlier build could write, so
/// there is nothing in the corpus for a re-render to find, and a bump would
/// stall attachment collection until one had run anyway.
///
/// v3 is the same rows read better: a task item's text now includes the title
/// of any document it links to, where before an atom contributed nothing and
/// "ask [Groceries] about milk" was stored as "ask about milk". Rows already
/// written hold the shortened text and would keep it until their document was
/// next saved, so the bump re-renders them.
pub const INDEX_VERSION: i64 = 3;

/// Record the title only, for paths that change a title without seeing content
/// (a rename, or materialising a row learned from a peer). Leaves counts,
/// links and the body untouched.
pub fn update_document_title(
    db: &rusqlite::Connection,
    doc_id: &str,
    title: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO document_index (document_id, title, todo_count, completed_todo_count)
         VALUES (?1, ?2, 0, 0)
         ON CONFLICT(document_id) DO UPDATE SET title = excluded.title",
        params![doc_id, title],
    )
    .map_err(|e| e.to_string())?;

    // An UPDATE here only ever touched documents that already had a row, and
    // the only thing that creates one is a save with content. A document that
    // arrived from a peer, or was created and never typed in, therefore had no
    // row at all and could not be found by search even by its exact title.
    //
    // FTS5 has no unique index for ON CONFLICT to target, so insert-or-replace
    // is a delete and an insert, carrying over whatever body a previous index
    // pass recorded.
    let body: String = db
        .query_row(
            "SELECT body FROM document_search WHERE document_id = ?",
            params![doc_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    db.execute(
        "DELETE FROM document_search WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO document_search (document_id, title, body) VALUES (?1, ?2, ?3)",
        params![doc_id, title, body],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Record everything the editor extracted from a save.
pub fn update_document_index(
    db: &rusqlite::Connection,
    doc_id: &str,
    title: &str,
    index: &DocumentIndexInput,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO document_index (document_id, title, todo_count, completed_todo_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(document_id) DO UPDATE SET
             title                = excluded.title,
             todo_count           = excluded.todo_count,
             completed_todo_count = excluded.completed_todo_count",
        params![doc_id, title, index.todo_count, index.completed_todo_count],
    )
    .map_err(|e| e.to_string())?;

    // Replace rather than diff: a document's outgoing links are small and
    // wholly determined by its current content, so the set is authoritative.
    db.execute(
        "DELETE FROM document_links WHERE source_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;

    // Same for attachments: what the document embeds now is the whole truth
    // about what it embeds.
    db.execute(
        "DELETE FROM document_attachments WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    for hash in &index.attachment_hashes {
        db.execute(
            "INSERT OR IGNORE INTO document_attachments (document_id, hash) VALUES (?, ?)",
            params![doc_id, hash],
        )
        .map_err(|e| e.to_string())?;
    }

    // And again for tags: the chips in the document now are the whole truth
    // about which tags it carries. Removing the last chip spelling a tag is how
    // a tag stops existing, so a stale row here would leave the picker offering
    // a tag that is nowhere in the corpus.
    db.execute(
        "DELETE FROM document_tags WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    for name in &index.tags {
        db.execute(
            "INSERT OR IGNORE INTO document_tags (document_id, name) VALUES (?, ?)",
            params![doc_id, name],
        )
        .map_err(|e| e.to_string())?;
    }

    // And again for todos: the items in the document now are the whole truth
    // about what todos it has. Replacing also renumbers, which is what keeps
    // an ordinal pointing at the line it named.
    db.execute(
        "DELETE FROM document_todos WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    for (ordinal, todo) in index.todos.iter().enumerate() {
        db.execute(
            "INSERT INTO document_todos (document_id, ordinal, text, checked, depth)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![doc_id, ordinal as i64, todo.text, todo.checked, todo.depth],
        )
        .map_err(|e| e.to_string())?;
    }

    db.execute(
        "UPDATE documents SET index_version = ?2 WHERE id = ?1",
        params![doc_id, INDEX_VERSION],
    )
    .map_err(|e| e.to_string())?;
    for target in &index.link_targets {
        if target == doc_id {
            continue; // a self-link is not a backlink worth reporting
        }
        db.execute(
            "INSERT OR IGNORE INTO document_links (source_id, target_id) VALUES (?, ?)",
            params![doc_id, target],
        )
        .map_err(|e| e.to_string())?;
    }

    // FTS5 has no upsert, so replace the row.
    db.execute(
        "DELETE FROM document_search WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO document_search (document_id, title, body) VALUES (?, ?, ?)",
        params![doc_id, title, &index.text],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Drop a document's derived rows. Incoming links are deliberately kept: the
/// other documents still contain the link, and the row would come back the
/// moment either is saved.
pub fn clear_document_index(db: &rusqlite::Connection, doc_id: &str) -> Result<(), String> {
    db.execute(
        "DELETE FROM document_links WHERE source_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    // A deleted document holds nothing, so its attachments become collectable.
    db.execute(
        "DELETE FROM document_attachments WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    // ...and its todos leave the index page, which is the point of deleting it.
    db.execute(
        "DELETE FROM document_todos WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    // ...and its tags stop being offered, for the same reason.
    db.execute(
        "DELETE FROM document_tags WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM document_search WHERE document_id = ?",
        params![doc_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Escape a user's query for FTS5's MATCH syntax.
///
/// Raw input cannot go in: a bare `"` or an unbalanced parenthesis is a syntax
/// error, and bare `AND`/`OR`/`NEAR` are operators. Each whitespace-separated
/// term becomes a quoted string with a prefix wildcard, so typing "meet" finds
/// "meeting" and nothing the user types is interpreted as syntax.
pub fn to_fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|t| t.replace(['"', '*'], " "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();

    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        crate::setup_database_tables(&db).unwrap();
        db.execute_batch(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('a', 'note', 'Alpha', 1, 1), ('b', 'note', 'Beta', 1, 1),
                        ('c', 'note', 'Gamma', 1, 1);",
        )
        .unwrap();
        db
    }

    fn index(text: &str, links: &[&str], todo: i32, done: i32) -> DocumentIndexInput {
        DocumentIndexInput {
            text: text.to_string(),
            link_targets: links.iter().map(|s| s.to_string()).collect(),
            attachment_hashes: vec![],
            tags: vec![],
            todo_count: todo,
            completed_todo_count: done,
            todos: vec![],
        }
    }

    fn with_attachments(hashes: &[&str]) -> DocumentIndexInput {
        DocumentIndexInput {
            attachment_hashes: hashes.iter().map(|s| s.to_string()).collect(),
            ..index("body", &[], 0, 0)
        }
    }

    fn with_tags(tags: &[&str]) -> DocumentIndexInput {
        DocumentIndexInput {
            tags: tags.iter().map(|s| s.to_string()).collect(),
            ..index("body", &[], 0, 0)
        }
    }

    /// The tag rows for a document, in a stable order for comparison.
    fn tags_of(db: &Connection, doc_id: &str) -> Vec<String> {
        let mut stmt = db
            .prepare("SELECT name FROM document_tags WHERE document_id = ? ORDER BY name")
            .unwrap();
        stmt.query_map([doc_id], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn tags_are_recorded() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work", "urgent"])).unwrap();
        assert_eq!(tags_of(&db, "a"), vec!["urgent", "work"]);
    }

    // Removing the last chip spelling a tag is the only way a tag stops
    // existing, so a row left behind would leave the picker offering a tag that
    // is nowhere in the corpus.
    #[test]
    fn tags_are_replaced_wholesale() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work", "urgent"])).unwrap();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work"])).unwrap();
        assert_eq!(tags_of(&db, "a"), vec!["work"]);
    }

    #[test]
    fn a_document_with_no_tags_has_no_rows() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work"])).unwrap();
        update_document_index(&db, "a", "Alpha", &with_tags(&[])).unwrap();
        assert!(tags_of(&db, "a").is_empty());
    }

    // The extractor deduplicates, but the write must not depend on it having:
    // the primary key is the document and the name.
    #[test]
    fn a_repeated_tag_is_one_row() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work", "work"])).unwrap();
        assert_eq!(tags_of(&db, "a"), vec!["work"]);
    }

    #[test]
    fn clearing_removes_tags() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work"])).unwrap();
        clear_document_index(&db, "a").unwrap();
        assert!(tags_of(&db, "a").is_empty());
    }

    #[test]
    fn deleting_a_document_row_cascades_to_its_tags() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work"])).unwrap();
        db.execute("DELETE FROM documents WHERE id = 'a'", [])
            .unwrap();
        assert!(tags_of(&db, "a").is_empty());
    }

    // Two documents can carry the same tag; that is the whole point of one.
    #[test]
    fn two_documents_can_carry_the_same_tag() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_tags(&["work"])).unwrap();
        update_document_index(&db, "b", "Beta", &with_tags(&["work"])).unwrap();
        assert_eq!(tags_of(&db, "a"), vec!["work"]);
        assert_eq!(tags_of(&db, "b"), vec!["work"]);
    }

    // A payload from a build that predates tags carries no `tags` field at all.
    #[test]
    fn an_index_payload_without_tags_still_deserialises() {
        let parsed: DocumentIndexInput = serde_json::from_str(
            r#"{"text":"body","linkTargets":[],"todoCount":0,"completedTodoCount":0}"#,
        )
        .expect("must parse");
        assert!(parsed.tags.is_empty());
    }

    fn with_todos(todos: &[(&str, bool, i64)]) -> DocumentIndexInput {
        let todos: Vec<TodoInput> = todos
            .iter()
            .map(|(text, checked, depth)| TodoInput {
                text: text.to_string(),
                checked: *checked,
                depth: *depth,
            })
            .collect();
        let total = todos.len() as i32;
        let done = todos.iter().filter(|t| t.checked).count() as i32;
        DocumentIndexInput {
            todos,
            ..index("body", &[], total, done)
        }
    }

    /// Every todo row for a document, in the order the index page reads them.
    fn todos_of(db: &Connection, doc_id: &str) -> Vec<(i64, String, bool, i64)> {
        let mut stmt = db
            .prepare(
                "SELECT ordinal, text, checked, depth FROM document_todos
                  WHERE document_id = ? ORDER BY ordinal",
            )
            .unwrap();
        stmt.query_map([doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    #[test]
    fn todos_are_recorded_in_order_with_their_ordinal() {
        let db = db();
        update_document_index(
            &db,
            "a",
            "Alpha",
            &with_todos(&[("buy milk", false, 0), ("pick dates", true, 1)]),
        )
        .unwrap();

        assert_eq!(
            todos_of(&db, "a"),
            vec![
                (0, "buy milk".to_string(), false, 0),
                (1, "pick dates".to_string(), true, 1),
            ]
        );
    }

    // Replacing rather than diffing is what renumbers the items, and the
    // ordinal is the address the index page navigates by. A stale row left
    // behind would send the cursor to a line that is no longer there.
    #[test]
    fn todos_are_replaced_wholesale_and_renumbered() {
        let db = db();
        update_document_index(
            &db,
            "a",
            "Alpha",
            &with_todos(&[
                ("first", false, 0),
                ("second", false, 0),
                ("third", false, 0),
            ]),
        )
        .unwrap();

        // The user deletes the first item.
        update_document_index(
            &db,
            "a",
            "Alpha",
            &with_todos(&[("second", false, 0), ("third", false, 0)]),
        )
        .unwrap();

        assert_eq!(
            todos_of(&db, "a"),
            vec![
                (0, "second".to_string(), false, 0),
                (1, "third".to_string(), false, 0),
            ]
        );
    }

    #[test]
    fn ticking_a_todo_is_recorded() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_todos(&[("buy milk", false, 0)])).unwrap();
        update_document_index(&db, "a", "Alpha", &with_todos(&[("buy milk", true, 0)])).unwrap();
        assert_eq!(
            todos_of(&db, "a"),
            vec![(0, "buy milk".to_string(), true, 0)]
        );
    }

    // An empty item is what a freshly inserted todo looks like. Dropping it
    // would shift every ordinal after it onto the wrong line.
    #[test]
    fn a_todo_with_no_text_still_takes_its_place() {
        let db = db();
        update_document_index(
            &db,
            "a",
            "Alpha",
            &with_todos(&[("", false, 0), ("second", false, 0)]),
        )
        .unwrap();
        assert_eq!(
            todos_of(&db, "a"),
            vec![
                (0, String::new(), false, 0),
                (1, "second".to_string(), false, 0)
            ]
        );
    }

    #[test]
    fn clearing_removes_todos() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_todos(&[("buy milk", false, 0)])).unwrap();
        clear_document_index(&db, "a").unwrap();
        assert!(todos_of(&db, "a").is_empty());
    }

    #[test]
    fn deleting_a_document_row_cascades_to_its_todos() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_todos(&[("buy milk", false, 0)])).unwrap();
        db.execute("DELETE FROM documents WHERE id = 'a'", [])
            .unwrap();
        assert!(todos_of(&db, "a").is_empty());
    }

    // A rename sees no content, so it has nothing to say about the todos.
    #[test]
    fn a_title_only_update_leaves_todos_alone() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_todos(&[("buy milk", false, 0)])).unwrap();
        update_document_title(&db, "a", "Renamed").unwrap();
        assert_eq!(
            todos_of(&db, "a"),
            vec![(0, "buy milk".to_string(), false, 0)]
        );
    }

    fn attachments_of(db: &Connection, doc_id: &str) -> Vec<String> {
        let mut stmt = db
            .prepare("SELECT hash FROM document_attachments WHERE document_id = ? ORDER BY hash")
            .unwrap();
        stmt.query_map([doc_id], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn attachment_references_are_recorded_and_replaced_wholesale() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_attachments(&["h1", "h2"])).unwrap();
        assert_eq!(attachments_of(&db, "a"), vec!["h1", "h2"]);

        // The second image is removed from the document.
        update_document_index(&db, "a", "Alpha", &with_attachments(&["h1"])).unwrap();
        assert_eq!(attachments_of(&db, "a"), vec!["h1"]);
    }

    #[test]
    fn indexing_stamps_the_document_as_indexed() {
        let db = db();
        let before: i64 = db
            .query_row(
                "SELECT index_version FROM documents WHERE id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0, "a document starts out never indexed");

        update_document_index(&db, "a", "Alpha", &index("x", &[], 0, 0)).unwrap();

        let after: i64 = db
            .query_row(
                "SELECT index_version FROM documents WHERE id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, INDEX_VERSION);
    }

    #[test]
    fn clearing_removes_attachment_references() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &with_attachments(&["h1"])).unwrap();
        clear_document_index(&db, "a").unwrap();
        assert!(attachments_of(&db, "a").is_empty());
    }

    fn links_to(db: &Connection, target: &str) -> Vec<String> {
        let mut stmt = db
            .prepare("SELECT source_id FROM document_links WHERE target_id = ? ORDER BY source_id")
            .unwrap();
        stmt.query_map([target], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn todo_counts_are_recorded_rather_than_hard_coded() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("body", &[], 5, 2)).unwrap();

        let (total, done): (i32, i32) = db
            .query_row(
                "SELECT todo_count, completed_todo_count FROM document_index WHERE document_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((total, done), (5, 2));
    }

    #[test]
    fn links_are_recorded_and_replaced_wholesale() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("x", &["b", "c"], 0, 0)).unwrap();
        assert_eq!(links_to(&db, "b"), vec!["a"]);
        assert_eq!(links_to(&db, "c"), vec!["a"]);

        // The link to c is removed from the document.
        update_document_index(&db, "a", "Alpha", &index("x", &["b"], 0, 0)).unwrap();
        assert_eq!(links_to(&db, "b"), vec!["a"]);
        assert!(
            links_to(&db, "c").is_empty(),
            "a removed link must not linger"
        );
    }

    #[test]
    fn a_self_link_is_not_recorded() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("x", &["a", "b"], 0, 0)).unwrap();
        assert!(links_to(&db, "a").is_empty());
        assert_eq!(links_to(&db, "b"), vec!["a"]);
    }

    #[test]
    fn a_duplicate_link_target_is_recorded_once() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("x", &["b", "b", "b"], 0, 0)).unwrap();
        assert_eq!(links_to(&db, "b"), vec!["a"]);
    }

    #[test]
    fn deleting_a_document_row_cascades_to_its_outgoing_links() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("x", &["b"], 0, 0)).unwrap();
        db.execute("DELETE FROM documents WHERE id = 'a'", [])
            .unwrap();
        assert!(links_to(&db, "b").is_empty());
    }

    #[test]
    fn the_search_index_holds_one_row_per_document() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("first body", &[], 0, 0)).unwrap();
        update_document_index(&db, "a", "Alpha", &index("second body", &[], 0, 0)).unwrap();

        let rows: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM document_search WHERE document_id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "a re-save must replace the row, not add one");

        let body: String = db
            .query_row(
                "SELECT body FROM document_search WHERE document_id = 'a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(body, "second body");
    }

    #[test]
    fn clearing_removes_outgoing_links_and_search_but_keeps_incoming() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("x", &["b"], 0, 0)).unwrap();
        update_document_index(&db, "b", "Beta", &index("y", &["a"], 0, 0)).unwrap();

        clear_document_index(&db, "a").unwrap();

        assert!(links_to(&db, "b").is_empty(), "a's outgoing link is gone");
        assert_eq!(
            links_to(&db, "a"),
            vec!["b"],
            "b still contains the link, so the incoming edge stays"
        );
    }

    #[test]
    fn a_title_only_update_leaves_counts_and_body_alone() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("the body", &[], 3, 1)).unwrap();
        update_document_title(&db, "a", "Renamed").unwrap();

        let (title, total): (String, i32) = db
            .query_row(
                "SELECT title, todo_count FROM document_index WHERE document_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(total, 3, "a rename must not reset the todo count");

        let (stitle, body): (String, String) = db
            .query_row(
                "SELECT title, body FROM document_search WHERE document_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stitle, "Renamed");
        assert_eq!(body, "the body");
    }

    // The regression this guards: a document whose content this device has
    // never rendered -- one pulled from a peer, or created and not yet typed
    // in -- had no search row, because only a save with content wrote one and
    // the title path could only UPDATE. It was unfindable even by exact title.
    #[test]
    fn a_document_with_no_body_is_searchable_by_title() {
        let db = db();
        update_document_title(&db, "a", "Quarterly review").unwrap();

        let q = to_fts_query("quarterly").unwrap();
        let hits: Vec<String> = db
            .prepare("SELECT document_id FROM document_search WHERE document_search MATCH ?")
            .unwrap()
            .query_map([&q], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(hits, vec!["a"]);
    }

    #[test]
    fn repeated_title_updates_keep_one_search_row() {
        let db = db();
        update_document_title(&db, "a", "First").unwrap();
        update_document_title(&db, "a", "Second").unwrap();
        update_document_title(&db, "a", "Third").unwrap();

        let (rows, title): (i64, String) = db
            .query_row(
                "SELECT COUNT(*), MAX(title) FROM document_search WHERE document_id = 'a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(title, "Third");
    }

    // A rename must not throw away the body a previous save indexed, which a
    // blind delete-and-insert would.
    #[test]
    fn a_rename_after_indexing_keeps_the_body_searchable() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("pineapple", &[], 0, 0)).unwrap();
        update_document_title(&db, "a", "Renamed").unwrap();

        let q = to_fts_query("pineapple").unwrap();
        let hits: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM document_search WHERE document_search MATCH ?",
                [&q],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the body survives a title-only update");
    }

    // FTS5 MATCH has its own syntax; raw user input is not valid query text.
    #[test]
    fn a_query_is_escaped_into_prefix_terms() {
        assert_eq!(to_fts_query("meeting"), Some("\"meeting\"*".to_string()));
        assert_eq!(
            to_fts_query("two words"),
            Some("\"two\"* AND \"words\"*".to_string())
        );
        assert_eq!(to_fts_query("   "), None);
        assert_eq!(to_fts_query(""), None);
    }

    #[test]
    fn query_syntax_characters_cannot_reach_fts() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("harmless", &[], 0, 0)).unwrap();

        // Each of these is a syntax error or an operator if passed through raw.
        for raw in [
            "\"",
            "a\"b",
            "*",
            "AND",
            "OR",
            "NEAR(",
            "(unbalanced",
            "a OR b",
        ] {
            let q = to_fts_query(raw);
            if let Some(q) = q {
                let result = db.query_row(
                    "SELECT COUNT(*) FROM document_search WHERE document_search MATCH ?",
                    [&q],
                    |r| r.get::<_, i64>(0),
                );
                assert!(result.is_ok(), "query {raw:?} -> {q:?} was not valid FTS5");
            }
        }
    }

    #[test]
    fn a_prefix_matches_a_longer_word() {
        let db = db();
        update_document_index(&db, "a", "Alpha", &index("meeting notes", &[], 0, 0)).unwrap();

        let q = to_fts_query("meet").unwrap();
        let hits: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM document_search WHERE document_search MATCH ?",
                [&q],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }
}
