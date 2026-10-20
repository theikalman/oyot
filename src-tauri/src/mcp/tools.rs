//! The tools an MCP client can call, and what each one reads (ADR 0037,
//! decision 5).
//!
//! Every tool here is answered from the tables the index keeps, so none of
//! them waits on the page. Each returns its answer twice: as text, which is
//! what an assistant reads, and as `structuredContent`, for a client that
//! wants the fields.

use super::access::{Access, Current};
use crate::commands::documents::{
    query_all_documents, query_all_tags, query_all_todos, query_backlinks,
    query_documents_with_tag, run_search, DocumentSummary,
};
use parking_lot::Mutex;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct Context {
    pub db: Arc<Mutex<Connection>>,
    pub access: Arc<Current>,
}

const SEARCH_DEFAULT: u64 = 10;
const SEARCH_MAX: u64 = 50;
const LIST_DEFAULT: u64 = 50;
const LIST_MAX: u64 = 200;
const TODOS_DEFAULT: u64 = 100;
const TODOS_MAX: u64 = 500;

/// The tools `access` allows, in the order a client shows them.
pub fn list(access: Access) -> Vec<Tool> {
    match access {
        Access::Off => Vec::new(),
        Access::ReadOnly => read_tools(),
    }
}

fn read_tools() -> Vec<Tool> {
    let kind = json!({
        "type": "string",
        "enum": ["note", "journal"],
        "description": "Only notes, or only journals. Both when left out."
    });
    vec![
        tool(
            "search_notes",
            "Search the user's notes and journals by words in their titles and text, best match first.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to find." },
                    "type": kind,
                    "limit": { "type": "integer", "minimum": 1, "maximum": SEARCH_MAX, "default": SEARCH_DEFAULT }
                },
                "required": ["query"]
            }),
        ),
        tool(
            "list_notes",
            "List notes and journals, newest first.",
            json!({
                "type": "object",
                "properties": {
                    "type": kind,
                    "pinned": { "type": "boolean", "description": "Only pinned notes, or only unpinned ones." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": LIST_MAX, "default": LIST_DEFAULT },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 }
                }
            }),
        ),
        tool(
            "list_todos",
            "List the tasks in the user's notes and journals, grouped by note. Each has the note's id and the task's ordinal within it.",
            json!({
                "type": "object",
                "properties": {
                    "checked": { "type": "boolean", "description": "Only done tasks, or only open ones." },
                    "note_id": { "type": "string", "description": "Only the tasks in this note." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": TODOS_MAX, "default": TODOS_DEFAULT }
                }
            }),
        ),
        tool(
            "list_tags",
            "List every tag in use, with how many notes carry it, most used first.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "notes_with_tag",
            "List the notes and journals carrying a tag.",
            json!({
                "type": "object",
                "properties": {
                    "tag": { "type": "string", "description": "The tag, with or without its #." }
                },
                "required": ["tag"]
            }),
        ),
        tool(
            "get_backlinks",
            "List the notes and journals that link to a note.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The note's id." }
                },
                "required": ["id"]
            }),
        ),
    ]
}

fn tool(name: &'static str, description: &'static str, schema: Value) -> Tool {
    let Value::Object(schema) = schema else {
        unreachable!("every schema here is an object")
    };
    Tool::new(name, description, schema).annotate(ToolAnnotations::new().read_only(true))
}

/// Call `name` with `args`. Every failure is a tool error, which the client
/// shows the assistant, rather than a protocol error, which it does not.
pub async fn call(ctx: Arc<Context>, name: &str, args: JsonObject) -> CallToolResult {
    let access = ctx.access.get();
    if access == Access::Off {
        return failed("Access for AI assistants is off in Oyot's settings.");
    }
    if !list(access).iter().any(|tool| tool.name == name) {
        return failed(&format!("There is no tool called {name:?}."));
    }

    let name = name.to_string();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let db = ctx.db.lock();
        answer(&db, &name, &Args(args))
    })
    .await;
    match answer {
        Ok(Ok(Answer { text, data })) => {
            let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
            result.structured_content = Some(data);
            result
        }
        Ok(Err(message)) => failed(&message),
        Err(e) => failed(&format!("Oyot could not answer: {e}")),
    }
}

fn failed(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.to_string())])
}

/// A tool's answer: what the assistant reads, and the same as fields.
struct Answer {
    text: String,
    data: Value,
}

fn answer(db: &Connection, name: &str, args: &Args) -> Result<Answer, String> {
    match name {
        "search_notes" => search_notes(db, args),
        "list_notes" => list_notes(db, args),
        "list_todos" => list_todos(db, args),
        "list_tags" => list_tags(db),
        "notes_with_tag" => notes_with_tag(db, args),
        "get_backlinks" => get_backlinks(db, args),
        _ => Err(format!("There is no tool called {name:?}.")),
    }
}

fn search_notes(db: &Connection, args: &Args) -> Result<Answer, String> {
    let query = args.required_str("query")?;
    let kind = args.kind()?;
    let limit = args.count("limit", SEARCH_DEFAULT, 1, SEARCH_MAX)?;
    let hits = run_search(db, query, kind, limit as usize)?;
    if hits.is_empty() {
        return Ok(Answer {
            text: format!("Nothing matches {query:?}."),
            data: json!({ "results": [] }),
        });
    }
    let mut text = String::new();
    let mut results = Vec::new();
    for hit in hits {
        let snippet = unmark(&hit.snippet);
        text.push_str(&format!(
            "- {} ({}, id {})\n",
            hit.title, hit.doc_type, hit.id
        ));
        if !snippet.is_empty() {
            text.push_str(&format!("  {snippet}\n"));
        }
        results.push(json!({
            "id": hit.id,
            "title": hit.title,
            "type": hit.doc_type,
            "snippet": snippet,
        }));
    }
    Ok(Answer {
        text,
        data: json!({ "results": results }),
    })
}

fn list_notes(db: &Connection, args: &Args) -> Result<Answer, String> {
    let kind = args.kind()?;
    let pinned = args.optional_bool("pinned")?;
    let limit = args.count("limit", LIST_DEFAULT, 1, LIST_MAX)? as usize;
    let offset = args.count("offset", 0, 0, u64::MAX)? as usize;

    let matching: Vec<DocumentSummary> = query_all_documents(db)?
        .documents
        .into_iter()
        .filter(|d| kind.is_none_or(|k| d.doc_type == k))
        .filter(|d| pinned.is_none_or(|p| d.pinned == p))
        .collect();
    let total = matching.len();
    let page: Vec<&DocumentSummary> = matching.iter().skip(offset).take(limit).collect();
    let next = (offset + page.len() < total).then_some(offset + page.len());

    let mut text = if page.is_empty() {
        "No notes.\n".to_string()
    } else {
        page.iter().map(|d| summary_line(d)).collect::<String>()
    };
    if let Some(next) = next {
        text.push_str(&format!(
            "\n{} of {total} shown. Pass offset {next} for more.\n",
            page.len()
        ));
    }
    Ok(Answer {
        text,
        data: json!({
            "notes": page.iter().map(|d| summary_json(d)).collect::<Vec<_>>(),
            "total": total,
            "next_offset": next,
        }),
    })
}

fn list_todos(db: &Connection, args: &Args) -> Result<Answer, String> {
    let checked = args.optional_bool("checked")?;
    let note_id = args.optional_str("note_id")?;
    let limit = args.count("limit", TODOS_DEFAULT, 1, TODOS_MAX)? as usize;

    let matching: Vec<_> = query_all_todos(db)?
        .into_iter()
        .filter(|t| checked.is_none_or(|c| t.checked == c))
        .filter(|t| note_id.is_none_or(|id| t.document_id == id))
        .collect();
    let total = matching.len();

    let mut text = String::new();
    let mut last_note: Option<&str> = None;
    for todo in matching.iter().take(limit) {
        if last_note != Some(todo.document_id.as_str()) {
            if last_note.is_some() {
                text.push('\n');
            }
            text.push_str(&format!(
                "## {} (id {})\n",
                todo.document_title, todo.document_id
            ));
            last_note = Some(&todo.document_id);
        }
        let indent = "  ".repeat(todo.depth.max(0) as usize);
        let mark = if todo.checked { "x" } else { " " };
        text.push_str(&format!(
            "{indent}- [{mark}] {} (ordinal {})\n",
            todo.text, todo.ordinal
        ));
    }
    if text.is_empty() {
        text = "No tasks.\n".to_string();
    }
    if total > limit {
        text.push_str(&format!("\n{limit} of {total} shown.\n"));
    }
    let todos: Vec<Value> = matching
        .iter()
        .take(limit)
        .map(|t| {
            json!({
                "note_id": t.document_id,
                "note_title": t.document_title,
                "note_type": t.doc_type,
                "ordinal": t.ordinal,
                "text": t.text,
                "checked": t.checked,
                "depth": t.depth,
            })
        })
        .collect();
    Ok(Answer {
        text,
        data: json!({ "todos": todos, "total": total }),
    })
}

fn list_tags(db: &Connection) -> Result<Answer, String> {
    let tags = query_all_tags(db)?;
    let text = if tags.is_empty() {
        "No tags.\n".to_string()
    } else {
        tags.iter()
            .map(|t| {
                format!(
                    "- #{} ({} {})\n",
                    t.name,
                    t.document_count,
                    plural(t.document_count, "note")
                )
            })
            .collect()
    };
    Ok(Answer {
        text,
        data: json!({
            "tags": tags.iter().map(|t| json!({ "name": t.name, "notes": t.document_count })).collect::<Vec<_>>()
        }),
    })
}

fn notes_with_tag(db: &Connection, args: &Args) -> Result<Answer, String> {
    let tag = normalize_tag(args.required_str("tag")?);
    if tag.is_empty() {
        return Err("A tag needs a name.".to_string());
    }
    let notes = query_documents_with_tag(db, &tag)?;
    Ok(summaries(notes, &format!("No note carries #{tag}.")))
}

fn get_backlinks(db: &Connection, args: &Args) -> Result<Answer, String> {
    let id = args.required_str("id")?;
    let title: Option<String> = db
        .query_row(
            "SELECT title FROM documents WHERE id = ?1 AND is_deleted = 0",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(title) = title else {
        return Err(format!("There is no note with id {id:?}."));
    };
    let notes = query_backlinks(db, id)?;
    Ok(summaries(notes, &format!("Nothing links to {title}.")))
}

fn summaries(notes: Vec<DocumentSummary>, none: &str) -> Answer {
    let text = if notes.is_empty() {
        format!("{none}\n")
    } else {
        notes.iter().map(summary_line).collect()
    };
    Answer {
        text,
        data: json!({ "notes": notes.iter().map(summary_json).collect::<Vec<_>>() }),
    }
}

fn summary_line(d: &DocumentSummary) -> String {
    let mut line = format!(
        "- {} ({}, id {}, updated {}",
        d.title,
        d.doc_type,
        d.id,
        day(d.updated_at)
    );
    if d.pinned {
        line.push_str(", pinned");
    }
    if d.todo_count > 0 {
        line.push_str(&format!(
            ", {} of {} tasks done",
            d.completed_todo_count, d.todo_count
        ));
    }
    line.push_str(")\n");
    line
}

fn summary_json(d: &DocumentSummary) -> Value {
    json!({
        "id": d.id,
        "title": d.title,
        "type": d.doc_type,
        "created_at": iso(d.created_at),
        "updated_at": iso(d.updated_at),
        "pinned": d.pinned,
        "todos": d.todo_count,
        "todos_done": d.completed_todo_count,
    })
}

/// The search snippet's match markers, ASCII STX and ETX, as Markdown bold.
fn unmark(snippet: &str) -> String {
    snippet.replace(['\u{2}', '\u{3}'], "**")
}

/// As `normalizeTagName` in src/lib/tiptap/tags.ts: what the index stores.
fn normalize_tag(raw: &str) -> String {
    let trimmed = raw.trim_start_matches(|c: char| c == '#' || c.is_whitespace());
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .to_lowercase()
        .chars()
        .take(50)
        .collect::<String>()
        .trim()
        .to_string()
}

fn day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.to_rfc3339())
}

fn plural(n: i64, word: &str) -> String {
    if n == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

/// A call's arguments, read with the errors an assistant can act on.
struct Args(JsonObject);

impl Args {
    fn required_str(&self, key: &str) -> Result<&str, String> {
        self.optional_str(key)?
            .ok_or_else(|| format!("{key} is required."))
    }

    fn optional_str(&self, key: &str) -> Result<Option<&str>, String> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(format!("{key} must be a string.")),
        }
    }

    fn optional_bool(&self, key: &str) -> Result<Option<bool>, String> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{key} must be true or false.")),
        }
    }

    fn count(&self, key: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(v) => v
                .as_u64()
                .filter(|n| (min..=max).contains(n))
                .ok_or_else(|| format!("{key} must be a whole number from {min} to {max}.")),
        }
    }

    fn kind(&self) -> Result<Option<&str>, String> {
        match self.optional_str("type")? {
            None => Ok(None),
            Some(k @ ("note" | "journal")) => Ok(Some(k)),
            Some(_) => Err("type must be \"note\" or \"journal\".".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_is_matched_as_the_index_spells_it() {
        assert_eq!(normalize_tag("#House  Move "), "house move");
        assert_eq!(normalize_tag("  ##Travel"), "travel");
        assert_eq!(normalize_tag(&"x".repeat(80)).len(), 50);
    }

    #[test]
    fn search_marks_become_bold() {
        assert_eq!(unmark("a \u{2}word\u{3} here"), "a **word** here");
    }

    #[test]
    fn off_lists_nothing_and_read_only_lists_only_tools_that_read() {
        assert!(list(Access::Off).is_empty());
        let tools = list(Access::ReadOnly);
        assert_eq!(tools.len(), 6);
        for tool in tools {
            let hint = tool.annotations.as_ref().and_then(|a| a.read_only_hint);
            assert_eq!(hint, Some(true), "{}", tool.name);
        }
    }

    #[test]
    fn arguments_are_checked_with_messages_an_assistant_can_act_on() {
        let args = Args(
            serde_json::from_value(json!({ "limit": 0, "type": "memo", "pinned": "yes" })).unwrap(),
        );
        assert_eq!(
            args.count("limit", 10, 1, 50),
            Err("limit must be a whole number from 1 to 50.".into())
        );
        assert!(args.kind().is_err());
        assert!(args.optional_bool("pinned").is_err());
        assert_eq!(args.required_str("query"), Err("query is required.".into()));
        assert_eq!(args.count("offset", 0, 0, u64::MAX), Ok(0));
    }
}
