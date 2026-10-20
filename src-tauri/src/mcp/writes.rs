//! The tools that change notes, offered only with read-and-write access (ADR
//! 0037, decisions 4 and 7 to 9).
//!
//! Each checks in SQL what it can, then asks the page, which makes the change
//! the way the user's own edit is made (src/lib/mcp/writes.ts): in the open
//! editor when the note is open, saved and sent to paired devices otherwise.
//! None of them deletes a note (decision 11).

use super::notes::{journal_id, note_row};
use super::tools::{tool, Answer, Args, Context};
use rmcp::model::{Tool, ToolAnnotations};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const NAMES: [&str; 6] = [
    "create_note",
    "edit_note",
    "append_to_note",
    "append_to_journal",
    "rename_note",
    "toggle_todo",
];

/// A title longer than this is not a title.
const MAX_TITLE: usize = 200;

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn tools() -> Vec<Tool> {
    let markdown = json!({
        "type": "string",
        "description": "Markdown, written as read_note writes it."
    });
    vec![
        write_tool(
            "create_note",
            "Create a note, with Markdown in it if given. Returns its id.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "markdown": markdown
                },
                "required": ["title"]
            }),
            false,
        ),
        write_tool(
            "edit_note",
            "Rewrite a note whole. Read it with read_note first and send all of it back with the \
             revision read_note gave: blocks left exactly as they were are kept as they are, so \
             change only what needs changing. If the note changed since, nothing is written and \
             the note is returned as it is now. To tick a task use toggle_todo, and to add to the \
             end use append_to_note.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "markdown": markdown,
                    "revision": { "type": "string", "description": "The revision read_note returned." },
                    "accept_formatting_loss": {
                        "type": "boolean",
                        "default": false,
                        "description": "Rewrite blocks Markdown cannot fully carry, losing what it cannot (an image's size, a table's column widths). Only after being told what would be lost."
                    }
                },
                "required": ["id", "markdown", "revision"]
            }),
            true,
        ),
        write_tool(
            "append_to_note",
            "Add Markdown to the end of a note. Needs no revision.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" }, "markdown": markdown },
                "required": ["id", "markdown"]
            }),
            false,
        ),
        write_tool(
            "append_to_journal",
            "Add Markdown to the end of a day's journal, making the journal if the day has none.",
            json!({
                "type": "object",
                "properties": {
                    "date": { "type": "string", "description": "The day, as YYYY-MM-DD. Today when left out." },
                    "markdown": markdown
                },
                "required": ["markdown"]
            }),
            false,
        ),
        write_tool(
            "rename_note",
            "Change a note's title. A journal is named for its day and cannot be renamed.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" }, "title": { "type": "string" } },
                "required": ["id", "title"]
            }),
            false,
        ),
        write_tool(
            "toggle_todo",
            "Tick or untick one task, named as list_todos names it: the note's id, the task's \
             ordinal, and its text, which is checked so a task that moved is not changed by \
             mistake.",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string" },
                    "ordinal": { "type": "integer", "minimum": 0 },
                    "text": { "type": "string" },
                    "checked": { "type": "boolean", "description": "Whether it should be ticked." }
                },
                "required": ["note_id", "ordinal", "text", "checked"]
            }),
            false,
        ),
    ]
}

fn write_tool(
    name: &'static str,
    description: &'static str,
    schema: Value,
    destructive: bool,
) -> Tool {
    let mut annotations = ToolAnnotations::new().read_only(false);
    annotations.destructive_hint = Some(destructive);
    annotations.idempotent_hint = Some(name == "toggle_todo" || name == "rename_note");
    let mut built = tool(name, description, schema);
    built.annotations = Some(annotations);
    built
}

pub async fn answer(ctx: &Arc<Context>, name: &str, args: &Args) -> Result<Answer, String> {
    match name {
        "create_note" => create_note(ctx, args).await,
        "edit_note" => edit_note(ctx, args).await,
        "append_to_note" => {
            let id = args.required_str("id")?.to_string();
            let markdown = args.required_str("markdown")?.to_string();
            existing(ctx, &id).await?;
            append(ctx, id, markdown).await
        }
        "append_to_journal" => append_to_journal(ctx, args).await,
        "rename_note" => rename_note(ctx, args).await,
        "toggle_todo" => toggle_todo(ctx, args).await,
        _ => Err(format!("There is no tool called {name:?}.")),
    }
}

/// The note's type and title, or the error an assistant reads when there is
/// no such note.
async fn existing(ctx: &Arc<Context>, id: &str) -> Result<super::notes::NoteRow, String> {
    let owned = id.to_string();
    ctx.sql(move |db| note_row(db, &owned))
        .await?
        .ok_or_else(|| format!("There is no note with id {id:?}."))
}

fn title(args: &Args) -> Result<String, String> {
    let title = args.required_str("title")?.trim();
    if title.is_empty() {
        return Err("A title cannot be empty.".to_string());
    }
    if title.chars().count() > MAX_TITLE {
        return Err(format!("A title can be at most {MAX_TITLE} characters."));
    }
    Ok(title.to_string())
}

#[derive(Deserialize)]
struct Revised {
    status: String,
    revision: Option<String>,
}

async fn create_note(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let title = title(args)?;
    let markdown = args.optional_str("markdown")?.unwrap_or("").to_string();
    let created: Value = ctx
        .page
        .ask(
            "createNote",
            json!({ "title": title, "markdown": markdown }),
        )
        .await?;
    let id = created["id"].as_str().unwrap_or_default().to_string();
    let revision = created["revision"].as_str().unwrap_or_default().to_string();
    Ok(Answer::new(
        format!("Created {title} (id {id}). Revision: {revision}\n"),
        json!({ "id": id, "title": title, "revision": revision }),
    ))
}

async fn append(ctx: &Arc<Context>, id: String, markdown: String) -> Result<Answer, String> {
    let done: Revised = parse(
        ctx.page
            .ask("appendNote", json!({ "docId": id, "markdown": markdown }))
            .await?,
    )?;
    let revision = done.revision.unwrap_or_default();
    let text = if done.status == "changed" {
        format!("Added to {id}. Revision: {revision}\n")
    } else {
        "There was nothing to add.\n".to_string()
    };
    Ok(Answer::new(
        text,
        json!({ "id": id, "status": done.status, "revision": revision }),
    ))
}

async fn append_to_journal(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let date = match args.optional_str("date")? {
        Some(date) => date.to_string(),
        None => chrono::Local::now().format("%Y-%m-%d").to_string(),
    };
    let markdown = args.required_str("markdown")?.to_string();
    let id = journal_id(&date)?;
    let found: Option<String> = {
        let id = id.clone();
        ctx.sql(move |db| {
            db.query_row(
                "SELECT id FROM documents WHERE type = 'journal' AND id = ?1 AND is_deleted = 0",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await?
    };
    let id = match found {
        Some(id) => id,
        // Made by the page, as the calendar makes one, so the sidebar
        // lists it and paired devices hear of it.
        None => {
            let made = ctx
                .page
                .ask("createJournal", json!({ "date": date }))
                .await?;
            made["id"]
                .as_str()
                .ok_or("Oyot's window did not say which journal it made.")?
                .to_string()
        }
    };
    append(ctx, id, markdown).await
}

#[derive(Deserialize)]
struct Lossy {
    index: usize,
    markdown: String,
    losses: Vec<String>,
}

async fn edit_note(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let id = args.required_str("id")?.to_string();
    let markdown = args.required_str("markdown")?.to_string();
    let revision = args.required_str("revision")?.to_string();
    let accept = args
        .optional_bool("accept_formatting_loss")?
        .unwrap_or(false);
    existing(ctx, &id).await?;

    let result = ctx
        .page
        .ask(
            "editNote",
            json!({
                "docId": id,
                "markdown": markdown,
                "revision": revision,
                "acceptFormattingLoss": accept,
            }),
        )
        .await?;
    let status = result["status"].as_str().unwrap_or_default();
    match status {
        "changed" | "unchanged" => {
            let revision = result["revision"].as_str().unwrap_or_default();
            let text = if status == "changed" {
                let blocks = result["blocks"].as_u64().unwrap_or(0);
                format!(
                    "Saved, {blocks} {} changed. Revision: {revision}\n",
                    plural(blocks, "block")
                )
            } else {
                format!("Nothing changed. Revision: {revision}\n")
            };
            Ok(Answer::new(
                text,
                json!({ "id": id, "status": status, "revision": revision }),
            ))
        }
        "conflict" => Err(format!(
            "The note changed since it was read, so nothing was written. Here it is now, at \
             revision {}. Make the change again on this and send it with that revision.\n\n{}",
            result["revision"].as_str().unwrap_or_default(),
            result["markdown"].as_str().unwrap_or_default()
        )),
        "lossy" => {
            let lossy: Vec<Lossy> = serde_json::from_value(result["lossy"].clone())
                .map_err(|e| format!("Oyot's window answered with something else: {e}"))?;
            let mut text = String::from(
                "Nothing was written. These blocks hold what Markdown cannot write, and the \
                 rewrite would lose it:\n",
            );
            for block in &lossy {
                text.push_str(&format!(
                    "\n- block {}, which would lose {}:\n{}\n",
                    block.index + 1,
                    block.losses.join(" and "),
                    indent(&block.markdown)
                ));
            }
            text.push_str(
                "\nLeave those blocks exactly as read_note gave them, or send \
                 accept_formatting_loss: true if the user is happy to lose that.",
            );
            Err(text)
        }
        "too_long" => Err(
            "The note is too long to rewrite whole, since it was cut short when read. Use \
             append_to_note to add to it, or ask the user to edit it."
                .to_string(),
        ),
        other => Err(format!("Oyot's window answered {other:?}.")),
    }
}

async fn rename_note(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let id = args.required_str("id")?.to_string();
    let title = title(args)?;
    let row = existing(ctx, &id).await?;
    if row.kind == "journal" {
        return Err("A journal is named for its day and cannot be renamed.".to_string());
    }
    let renamed = ctx
        .page
        .ask("renameNote", json!({ "docId": id, "title": title }))
        .await?;
    let now = renamed["title"].as_str().unwrap_or(&title).to_string();
    Ok(Answer::new(
        format!("Renamed {} to {now}.\n", row.title),
        json!({ "id": id, "title": now }),
    ))
}

#[derive(Deserialize)]
struct Toggled {
    status: String,
    todos: Option<Vec<TodoRow>>,
}

#[derive(Deserialize, serde::Serialize)]
struct TodoRow {
    ordinal: u64,
    text: String,
    checked: bool,
    depth: u64,
}

async fn toggle_todo(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let id = args.required_str("note_id")?.to_string();
    let ordinal = args.count("ordinal", 0, 0, u32::MAX as u64)?;
    if args.0.get("ordinal").is_none() {
        return Err("ordinal is required.".to_string());
    }
    let text = args.required_str("text")?.to_string();
    let checked = args.required_bool("checked")?;
    existing(ctx, &id).await?;

    let toggled: Toggled = parse(
        ctx.page
            .ask(
                "toggleTodo",
                json!({ "docId": id, "ordinal": ordinal, "text": text, "checked": checked }),
            )
            .await?,
    )?;
    let state = if checked { "ticked" } else { "not ticked" };
    match toggled.status.as_str() {
        "changed" => Ok(Answer::new(
            format!("{text:?} is now {state}.\n"),
            json!({ "status": "changed", "checked": checked }),
        )),
        "unchanged" => Ok(Answer::new(
            format!("{text:?} was already {state}.\n"),
            json!({ "status": "unchanged", "checked": checked }),
        )),
        "moved" => {
            let todos = toggled.todos.unwrap_or_default();
            let mut message = format!(
                "Task {ordinal} in that note is no longer {text:?}, so nothing was changed. Its \
                 tasks are now:\n"
            );
            for todo in &todos {
                message.push_str(&format!(
                    "{}- [{}] {} (ordinal {})\n",
                    "  ".repeat(todo.depth as usize),
                    if todo.checked { "x" } else { " " },
                    todo.text,
                    todo.ordinal
                ));
            }
            Err(message)
        }
        other => Err(format!("Oyot's window answered {other:?}.")),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value)
        .map_err(|e| format!("Oyot's window answered with something else: {e}"))
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn plural(n: u64, word: &str) -> String {
    if n == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}
