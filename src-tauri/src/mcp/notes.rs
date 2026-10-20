//! The tools that read a note or an image, which need the page (ADR 0037,
//! decisions 6 and 10).
//!
//! What can be checked in SQL is checked here first, so the page is only
//! asked about notes that exist and images a live note holds. An image goes
//! straight from Rust when it is already fit to send; the page is asked to
//! redraw one that is too big, or that the header says is turned.

use super::imagesize;
use super::tools::{day, iso, tool, Answer, Args, Context, ImageBlock};
use crate::commands::attachments::{has_attachment, read_attachment_bytes};
use crate::commands::documents::format_journal_date;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rmcp::model::Tool;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// Kept in step with src/lib/mcp/images.ts, where the reasons are given.
const MAX_EDGE: u32 = 1568;
const RESULT_IMAGE_BUDGET: usize = 700_000;
const MAX_IMAGES_PER_NOTE: usize = 5;
const READABLE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Past this, a note is cut short with a notice: an assistant's context is
/// not the place for a book.
const MAX_MARKDOWN: usize = 200_000;

/// Below this much of the budget left, no more images are added.
const MIN_IMAGE_BUDGET: usize = 30_000;

const ATTACHMENT_SCHEME: &str = "oyot-attachment://";
const INLINE_SCHEME: &str = "oyot-inline-image://";

const NAMES: [&str; 3] = ["read_note", "get_journal", "read_attachment"];

pub fn handles(name: &str) -> bool {
    NAMES.contains(&name)
}

/// This module's tools, `read_attachment` last.
pub fn tools() -> Vec<Tool> {
    let include_images = json!({
        "type": "boolean",
        "default": false,
        "description": "Also return the note's images, as many as fit, after its text."
    });
    vec![
        tool(
            "read_note",
            "Read a note or journal as Markdown. Links to other notes are oyot://note/<id>, \
             images are oyot-attachment://<hash> or oyot-inline-image://<n>, tags are #name, \
             and tasks are - [ ] and - [x] items.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The note's id." },
                    "include_images": include_images
                },
                "required": ["id"]
            }),
        ),
        tool(
            "get_journal",
            "Read the journal for a day, if there is one.",
            json!({
                "type": "object",
                "properties": {
                    "date": { "type": "string", "description": "The day, as YYYY-MM-DD." },
                    "include_images": include_images
                },
                "required": ["date"]
            }),
        ),
        tool(
            "read_attachment",
            "Look at one image in a note: an oyot-attachment://<hash>, or an \
             oyot-inline-image://<n> with the id of the note it is in.",
            json!({
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "description": "The image's address, or its hash." },
                    "note_id": { "type": "string", "description": "The note an inline image is in." }
                },
                "required": ["ref"]
            }),
        ),
    ]
}

pub async fn answer(ctx: &Arc<Context>, name: &str, args: &Args) -> Result<Answer, String> {
    match name {
        "read_note" => {
            let id = args.required_str("id")?.to_string();
            let include = args.optional_bool("include_images")?.unwrap_or(false);
            read_note(ctx, id, include).await
        }
        "get_journal" => get_journal(ctx, args).await,
        "read_attachment" => read_attachment(ctx, args).await,
        _ => Err(format!("There is no tool called {name:?}.")),
    }
}

pub(super) struct NoteRow {
    pub kind: String,
    pub title: String,
    created_at: i64,
    updated_at: i64,
}

pub(super) fn note_row(db: &Connection, id: &str) -> Result<Option<NoteRow>, String> {
    db.query_row(
        "SELECT type, title, created_at, updated_at FROM documents WHERE id = ?1 AND is_deleted = 0",
        params![id],
        |row| {
            Ok(NoteRow {
                kind: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// What the page renders a note to (`readNote` in src/lib/mcp/relay.ts).
#[derive(Deserialize)]
struct Rendered {
    markdown: String,
    revision: String,
    images: Vec<RenderedImage>,
}

#[derive(Deserialize)]
struct RenderedImage {
    #[serde(rename = "ref")]
    reference: String,
    kind: String,
    alt: Option<String>,
}

pub(super) async fn read_note(
    ctx: &Arc<Context>,
    id: String,
    include_images: bool,
) -> Result<Answer, String> {
    let row = {
        let id = id.clone();
        ctx.sql(move |db| note_row(db, &id)).await?
    }
    .ok_or_else(|| format!("There is no note with id {id:?}."))?;

    let rendered: Rendered =
        serde_json::from_value(ctx.page.ask("readNote", json!({ "docId": id })).await?)
            .map_err(|e| format!("Oyot's window answered with something else: {e}"))?;

    let hashes: Vec<String> = rendered
        .images
        .iter()
        .filter(|i| i.kind == "attachment")
        .map(|i| i.reference.clone())
        .collect();
    let stored = ctx.sql(move |db| stored_attachments(db, &hashes)).await?;

    let mut text = format!(
        "Title: {}\nId: {} ({})\nCreated {}, updated {}\nRevision: {}\n",
        row.title,
        id,
        row.kind,
        day(row.created_at),
        day(row.updated_at),
        rendered.revision
    );
    let mut images = Vec::new();
    if !rendered.images.is_empty() {
        text.push_str("Images (see read_attachment):\n");
    }
    for image in &rendered.images {
        let (address, detail, available) = if image.kind == "inline" {
            (
                format!("{INLINE_SCHEME}{}", image.reference),
                "inline; give read_attachment this note's id".to_string(),
                true,
            )
        } else {
            let found = stored.get(&image.reference);
            let detail = match found {
                Some((mime, true)) => mime.clone(),
                Some((mime, false)) => format!("{mime}, not on this device yet"),
                None => "not on this device yet".to_string(),
            };
            (
                format!("{ATTACHMENT_SCHEME}{}", image.reference),
                detail,
                matches!(found, Some((_, true))),
            )
        };
        let alt = image
            .alt
            .as_deref()
            .map(|a| format!(" \"{a}\""))
            .unwrap_or_default();
        text.push_str(&format!("- {address}{alt} ({detail})\n"));
        images.push(json!({
            "ref": address,
            "kind": image.kind,
            "alt": image.alt,
            "mime": found_mime(&stored, image),
            "available": available,
        }));
    }

    let truncated = rendered.markdown.len() > MAX_MARKDOWN;
    let markdown = if truncated {
        let mut cut = MAX_MARKDOWN;
        while !rendered.markdown.is_char_boundary(cut) {
            cut -= 1;
        }
        format!(
            "{}\n\n[Cut short: the note is {} KB, and only the first {} KB is shown.]\n",
            &rendered.markdown[..cut],
            rendered.markdown.len() / 1000,
            MAX_MARKDOWN / 1000
        )
    } else {
        rendered.markdown.clone()
    };
    text.push_str("\n---\n\n");
    text.push_str(&markdown);

    let mut answer = Answer::new(
        text,
        json!({
            "id": id,
            "title": row.title,
            "type": row.kind,
            "created_at": iso(row.created_at),
            "updated_at": iso(row.updated_at),
            "revision": rendered.revision,
            "markdown": markdown,
            "truncated": truncated,
            "images": images,
        }),
    );

    if include_images {
        let mut budget = RESULT_IMAGE_BUDGET;
        let mut skipped = Vec::new();
        for (n, image) in rendered.images.iter().enumerate() {
            if answer.images.len() >= MAX_IMAGES_PER_NOTE || budget < MIN_IMAGE_BUDGET {
                skipped.push(format!("image {} (no room left in this answer)", n + 1));
                continue;
            }
            let target = if image.kind == "inline" {
                Target::Inline {
                    note_id: id.clone(),
                    id: image.reference.clone(),
                }
            } else {
                Target::Attachment(image.reference.clone())
            };
            match fetch_image(ctx, &target, budget).await {
                Ok(fitted) => {
                    budget = budget.saturating_sub(fitted.bytes.len());
                    answer.images.push(fitted.block(&target.address(), n + 1));
                }
                Err(reason) => skipped.push(format!("image {}: {reason}", n + 1)),
            }
        }
        if !skipped.is_empty() {
            answer.text.push_str(&format!(
                "\n[Images not included: {}]\n",
                skipped.join("; ")
            ));
        }
    }
    Ok(answer)
}

fn found_mime(stored: &HashMap<String, (String, bool)>, image: &RenderedImage) -> Option<String> {
    if image.kind == "inline" {
        return None;
    }
    stored.get(&image.reference).map(|(mime, _)| mime.clone())
}

/// Each hash's stored type, and whether this device holds its bytes.
fn stored_attachments(
    db: &Connection,
    hashes: &[String],
) -> Result<HashMap<String, (String, bool)>, String> {
    let mut out = HashMap::new();
    let mut stmt = db
        .prepare("SELECT mime_type, is_fully_downloaded FROM attachments WHERE hash = ?1")
        .map_err(|e| e.to_string())?;
    for hash in hashes {
        let row: Option<(String, i64)> = stmt
            .query_row(params![hash], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((mime, held)) = row {
            out.insert(hash.clone(), (mime, held == 1));
        }
    }
    Ok(out)
}

async fn get_journal(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let date = args.required_str("date")?.to_string();
    let include = args.optional_bool("include_images")?.unwrap_or(false);
    let id = journal_id(&date)?;
    let id: Option<String> = ctx
        .sql(move |db| {
            db.query_row(
                "SELECT id FROM documents WHERE type = 'journal' AND id = ?1 AND is_deleted = 0",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await?;
    match id {
        Some(id) => read_note(ctx, id, include).await,
        None => Ok(Answer::new(
            format!("There is no journal for {date}.\n"),
            json!({ "date": date, "found": false }),
        )),
    }
}

/// A journal's id, from its day: the title is the day as `YYYY-MM-DD`, and
/// the id is the day written out (`20 Oct 2026`), which is what lets two
/// devices that both make the day's journal end up with one.
pub(super) fn journal_id(date: &str) -> Result<String, String> {
    const BAD: &str = "date must be a day, as YYYY-MM-DD.";
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| BAD.to_string())?;
    format_journal_date(date).ok_or_else(|| BAD.to_string())
}

/// An image, by where it is kept.
enum Target {
    Attachment(String),
    Inline { note_id: String, id: String },
}

impl Target {
    fn address(&self) -> String {
        match self {
            Target::Attachment(hash) => format!("{ATTACHMENT_SCHEME}{hash}"),
            Target::Inline { id, .. } => format!("{INLINE_SCHEME}{id}"),
        }
    }

    /// What an assistant wrote, as an image: an address or a bare hash, and
    /// for an inline image the note it is in.
    fn parse(raw: &str, note_id: Option<&str>) -> Result<Target, String> {
        let raw = raw.trim();
        let hash = raw
            .strip_prefix(ATTACHMENT_SCHEME)
            .unwrap_or(raw)
            .to_lowercase();
        if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(Target::Attachment(hash));
        }
        let id = raw.strip_prefix(INLINE_SCHEME).unwrap_or(raw);
        if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
            let note_id = note_id.ok_or("An inline image needs note_id, the note it is in.")?;
            return Ok(Target::Inline {
                note_id: note_id.to_string(),
                id: id.to_string(),
            });
        }
        Err(format!(
            "{raw:?} is not an image. Use an {ATTACHMENT_SCHEME}<hash> or {INLINE_SCHEME}<n> from read_note."
        ))
    }
}

async fn read_attachment(ctx: &Arc<Context>, args: &Args) -> Result<Answer, String> {
    let target = Target::parse(args.required_str("ref")?, args.optional_str("note_id")?)?;
    let fitted = fetch_image(ctx, &target, RESULT_IMAGE_BUDGET).await?;
    let address = target.address();
    let mut answer = Answer::new(
        format!("{}\n", fitted.describe(&address)),
        json!({
            "ref": address,
            "mime": fitted.mime,
            "width": fitted.width,
            "height": fitted.height,
            "scaled": fitted.scaled,
            "first_frame_only": fitted.first_frame_only,
        }),
    );
    answer.images.push(fitted.block(&address, 1));
    Ok(answer)
}

/// An image ready to send.
struct Fitted {
    bytes: Vec<u8>,
    mime: String,
    width: Option<u32>,
    height: Option<u32>,
    scaled: bool,
    first_frame_only: bool,
}

impl Fitted {
    fn describe(&self, address: &str) -> String {
        let mut parts = vec![self.mime.clone()];
        if let (Some(w), Some(h)) = (self.width, self.height) {
            parts.push(format!("{w}x{h}"));
        }
        if self.scaled {
            parts.push("scaled down to fit".to_string());
        }
        if self.first_frame_only {
            parts.push("first frame only".to_string());
        }
        format!("{address} ({})", parts.join(", "))
    }

    fn block(&self, address: &str, n: usize) -> ImageBlock {
        ImageBlock {
            label: format!("Image {n}: {}", self.describe(address)),
            mime: self.mime.clone(),
            base64: BASE64.encode(&self.bytes),
        }
    }
}

/// What the database says of an attachment.
enum Held {
    /// No live note embeds it, so it is not the assistant's to see.
    NotInANote,
    /// A note embeds it, but this device does not have it yet.
    NotHere,
    Here,
}

fn attachment_held(db: &Connection, hash: &str) -> Result<Held, String> {
    let in_note: bool = db
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM document_attachments a
                              JOIN documents d ON d.id = a.document_id
                             WHERE a.hash = ?1 AND d.is_deleted = 0)",
            params![hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !in_note {
        return Ok(Held::NotInANote);
    }
    Ok(if has_attachment(db, hash)? {
        Held::Here
    } else {
        Held::NotHere
    })
}

async fn fetch_image(ctx: &Arc<Context>, target: &Target, budget: usize) -> Result<Fitted, String> {
    let (mime, bytes) = match target {
        Target::Attachment(hash) => {
            let held = {
                let hash = hash.clone();
                ctx.sql(move |db| attachment_held(db, &hash)).await?
            };
            match held {
                Held::NotInANote => {
                    return Err(format!("No note holds the image {}.", target.address()));
                }
                Held::NotHere => {
                    (ctx.fetch_attachment)(hash);
                    return Err(format!(
                        "{} is not on this device yet. Oyot has asked the user's other devices \
                         for it; try again in a minute.",
                        target.address()
                    ));
                }
                Held::Here => {}
            }
            let read = {
                let ctx = ctx.clone();
                let hash = hash.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    read_attachment_bytes(&ctx.db, &ctx.data_dir, &hash)
                })
                .await
                .map_err(|e| e.to_string())??
            };
            read.ok_or_else(|| format!("{} is not on this device yet.", target.address()))?
        }
        Target::Inline { note_id, id } => {
            let exists = {
                let note_id = note_id.clone();
                ctx.sql(move |db| note_row(db, &note_id)).await?.is_some()
            };
            if !exists {
                return Err(format!("There is no note with id {note_id:?}."));
            }
            let answer = ctx
                .page
                .ask("inlineImage", json!({ "docId": note_id, "id": id }))
                .await?;
            let image: PageImage = serde_json::from_value(answer)
                .map_err(|e| format!("Oyot's window answered with something else: {e}"))?;
            let bytes = BASE64
                .decode(image.base64)
                .map_err(|e| format!("Oyot's window sent an image that is not base64: {e}"))?;
            (image.mime, bytes)
        }
    };
    fit(ctx, mime, bytes, budget).await
}

#[derive(Deserialize)]
struct PageImage {
    mime: String,
    base64: String,
}

/// What the page made of an image it was asked to redraw
/// (`prepareImage` in src/lib/mcp/relay.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    ok: bool,
    reason: Option<String>,
    mime: Option<String>,
    base64: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default)]
    scaled: bool,
    #[serde(default)]
    first_frame_only: bool,
}

/// The image as it is when it is already fit to send, and otherwise as the
/// page redraws it.
async fn fit(
    ctx: &Arc<Context>,
    mime: String,
    bytes: Vec<u8>,
    budget: usize,
) -> Result<Fitted, String> {
    let readable = READABLE_TYPES.contains(&mime.as_str());
    let size = imagesize::dimensions(&bytes, &mime);
    let small = size.is_some_and(|(w, h)| w.max(h) <= MAX_EDGE);
    let upright = mime != "image/jpeg" || !imagesize::jpeg_is_turned(&bytes);
    if readable && small && upright && bytes.len() <= budget {
        return Ok(Fitted {
            bytes,
            mime,
            width: size.map(|s| s.0),
            height: size.map(|s| s.1),
            scaled: false,
            first_frame_only: false,
        });
    }

    let answer = ctx
        .page
        .ask(
            "prepareImage",
            json!({ "mime": mime, "base64": BASE64.encode(&bytes), "maxBytes": budget }),
        )
        .await?;
    let prepared: Prepared = serde_json::from_value(answer)
        .map_err(|e| format!("Oyot's window answered with something else: {e}"))?;
    if !prepared.ok {
        return Err(match prepared.reason.as_deref() {
            Some("unsupported_type") => format!("Oyot cannot read an image of type {mime}."),
            Some("too_large") => "The image is too large to send, even scaled down.".to_string(),
            other => format!(
                "The image could not be prepared: {}",
                other.unwrap_or("unknown")
            ),
        });
    }
    let (Some(mime), Some(base64)) = (prepared.mime, prepared.base64) else {
        return Err("Oyot's window sent an image with nothing in it.".to_string());
    };
    Ok(Fitted {
        bytes: BASE64
            .decode(base64)
            .map_err(|e| format!("Oyot's window sent an image that is not base64: {e}"))?,
        mime,
        width: prepared.width,
        height: prepared.height,
        scaled: prepared.scaled,
        first_frame_only: prepared.first_frame_only,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_is_named_by_its_address_or_its_hash() {
        let hash = "A".repeat(64);
        assert!(matches!(
            Target::parse(&format!("oyot-attachment://{hash}"), None),
            Ok(Target::Attachment(h)) if h == "a".repeat(64)
        ));
        assert!(matches!(
            Target::parse(&hash, None),
            Ok(Target::Attachment(_))
        ));
        assert!(matches!(
            Target::parse("oyot-inline-image://2", Some("n1")),
            Ok(Target::Inline { note_id, id }) if note_id == "n1" && id == "2"
        ));
        assert!(Target::parse("oyot-inline-image://2", None).is_err());
        assert!(Target::parse("cat.png", None).is_err());
    }
}
