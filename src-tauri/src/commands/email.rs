//! Emails attached to notes (docs/plans/email-attachments.md).
//!
//! An email is stored in the attachment store like an image, as
//! `<hash>.eml`, and a note holds only `oyot-attachment://<hash>` and the
//! few headers its chip shows. The page never reads the stored file: what it
//! shows of an email is what this module parses out of it.

use crate::attachment_types::{self, EMAIL_MIME, MAX_EMAIL_BYTES};
use crate::commands::attachments::{announce_image, read_attachment_bytes, store_attachment};
use crate::commands::picked;
use crate::db::AppState;
use base64::Engine;
use mail_parser::{AddressList, Mailbox, Message, MessagePart};
use std::collections::HashSet;
use std::io::Read;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// The longest a header kept in a note is. A header can be any length, and
/// what goes in a note is synced to every device and searched.
const MAX_HEADER_CHARS: usize = 300;

/// What a note keeps of an email it holds, beside its hash.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EmailSummary {
    pub subject: Option<String>,
    /// The sender, as `Name <address>`, or whichever of the two it has.
    pub from: Option<String>,
    /// When it was sent, in RFC 3339, for the page to show in the user's own
    /// format.
    pub date: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct AttachedEmail {
    pub hash: String,
    #[serde(flatten)]
    pub summary: EmailSummary,
}

/// Let the user pick an email, and store it.
///
/// The dialog is opened here, so the chosen path never crosses IPC, for the
/// reason `pick_and_import_image` gives: the webview renders content from
/// peers, and must not be able to name a file for the store to copy in.
///
/// Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_and_import_email(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<AttachedEmail>, String> {
    let dialog = app.dialog().file();
    // Only desktop filters. Android matches by MIME type, and providers call
    // an .eml file `message/rfc822` or `application/octet-stream` as they
    // please, so a filter there can make an email impossible to pick. What a
    // file is gets decided by reading it.
    #[cfg(desktop)]
    let dialog = dialog.add_filter("Emails", &["eml"]);

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };

    let handle = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || read_picked(&handle, &picked))
        .await
        .map_err(|e| format!("reading the email stopped unexpectedly: {e}"))??;

    let attached = import_email(&state, &bytes)?;
    Ok(Some(attached))
}

/// Read a picked file, refusing it once it is longer than an email may be
/// rather than reading all of it first. A phone's content URI may say nothing
/// of its size until it is read.
fn read_picked(app: &AppHandle, picked: &FilePath) -> Result<Vec<u8>, String> {
    let file =
        picked::open(app, picked).map_err(|e| format!("could not open the chosen file: {e}"))?;
    read_capped(file, MAX_EMAIL_BYTES)
}

fn read_capped(source: impl Read, cap: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    source
        .take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read the chosen file: {e}"))?;
    if bytes.len() > cap {
        return Err(format!(
            "this email is over the {} MB limit",
            cap / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

/// Store an email and tell connected devices about it.
fn import_email(state: &AppState, bytes: &[u8]) -> Result<AttachedEmail, String> {
    // Said plainly here, where the user chose the file, rather than in the
    // store's words about declared types.
    if attachment_types::sniff(bytes) != Some(EMAIL_MIME) {
        return Err("that file is not an email (.eml)".to_string());
    }
    let stored = store_attachment(state, bytes, EMAIL_MIME)?;
    announce_image(state, &stored);
    Ok(AttachedEmail {
        hash: stored.hash,
        summary: summarize(bytes),
    })
}

/// The headers a note keeps of an email.
pub fn summarize(bytes: &[u8]) -> EmailSummary {
    let Some(message) = mail_parser::MessageParser::new().parse(bytes) else {
        return EmailSummary {
            subject: None,
            from: None,
            date: None,
        };
    };
    let from = message
        .from()
        .and_then(|list| list.first())
        .and_then(mailbox_text);
    EmailSummary {
        subject: message.subject().and_then(header_text),
        from: from.as_deref().and_then(header_text),
        date: message
            .date()
            .filter(|date| date.is_valid())
            .map(|date| date.to_rfc3339()),
    }
}

/// A mailbox as `Name <address>`, or whichever of the two it has.
fn mailbox_text(mailbox: Mailbox<'_>) -> Option<String> {
    let name = mailbox.name().map(str::trim).filter(|s| !s.is_empty());
    let address = mailbox.address().map(str::trim).filter(|s| !s.is_empty());
    match (name, address) {
        (Some(name), Some(address)) => Some(format!("{name} <{address}>")),
        (Some(only), None) | (None, Some(only)) => Some(only.to_string()),
        (None, None) => None,
    }
}

// --- reading an email ----------------------------------------------------

/// The most of an email's pictures put into its page. Each is base64 inside
/// the HTML handed to the page, a third larger again, so a picture past this
/// is listed as a file instead.
const MAX_INLINED_BYTES: usize = 16 * 1024 * 1024;

/// The pictures an email's page may show from inside it: the raster types
/// the attachment store takes, so not SVG.
const INLINE_IMAGE_TYPES: [&str; 5] = ["png", "jpeg", "jpg", "gif", "webp"];

/// An email as the preview shows it.
///
/// Plain data only. The HTML is the email's own, hostile, and shown by the
/// page in a frame that runs nothing (ADR 0043); everything else is set as
/// text.
#[derive(Debug, serde::Serialize)]
pub struct EmailView {
    pub subject: Option<String>,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub date: Option<String>,
    /// The HTML body, with the pictures it carries put in as `data:`
    /// addresses. None for an email that has none.
    pub html: Option<String>,
    /// The text body, given only when there is no HTML one.
    pub text: Option<String>,
    /// The files it carries.
    pub parts: Vec<EmailPart>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct EmailPart {
    /// Where it is among the email's attachments, to ask for it by.
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

/// An email this device holds, read for the preview. `None` while its bytes
/// have not arrived from another device.
#[tauri::command]
pub async fn read_email(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<EmailView>, String> {
    let Some((mime, bytes)) = read_attachment_bytes(&state.db, &state.data_dir, &hash)? else {
        return Ok(None);
    };
    if !attachment_types::is_email(&mime) {
        return Err("that attachment is not an email".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || view_of(&bytes))
        .await
        .map_err(|e| format!("reading the email stopped unexpectedly: {e}"))?
        .map(Some)
}

/// What the preview shows of an email.
pub fn view_of(bytes: &[u8]) -> Result<EmailView, String> {
    let message = mail_parser::MessageParser::new()
        .parse(bytes)
        .ok_or_else(|| "this email could not be read".to_string())?;
    let summary = summarize(bytes);

    // `html_bodies` makes HTML of a text body too, so whether there is an
    // HTML body is asked of the parts.
    let has_html = message
        .html_body()
        .any(|part| part.is_content_type("text", "html"));
    let mut inlined = HashSet::new();
    let (html, text) = if has_html {
        let html = message.html_bodies().collect::<Vec<_>>().join("\n");
        (Some(with_pictures(&message, html, &mut inlined)), None)
    } else {
        let text = message.text_bodies().collect::<Vec<_>>().join("\n\n");
        (None, Some(text))
    };

    let parts = message
        .attachments()
        .enumerate()
        .filter(|(_, part)| !inlined.contains(&part.id()))
        .map(|(index, part)| EmailPart {
            index,
            name: part_name(&part),
            mime: part_type(&part),
            size: part.decoded_len() as u64,
        })
        .collect();

    Ok(EmailView {
        subject: summary.subject,
        from: summary.from,
        to: addresses(message.to()),
        cc: addresses(message.cc()),
        date: summary.date,
        html,
        text,
        parts,
    })
}

fn addresses(list: Option<AddressList<'_>>) -> Vec<String> {
    list.map(|list| list.mailboxes().filter_map(mailbox_text).collect())
        .unwrap_or_default()
}

/// The HTML with the email's own pictures in it.
///
/// A picture the HTML names by `cid:` takes the place of that address. One
/// the HTML does not name, but which the email shows as part of its body, is
/// put after it, which is where a mail client shows one. Remote pictures are
/// left as they are, for the frame's policy to refuse, as a mail client does
/// by default: they are how a sender learns an email was opened.
fn with_pictures(message: &Message<'_>, mut html: String, inlined: &mut HashSet<u32>) -> String {
    let mut budget = MAX_INLINED_BYTES;
    let mut seen = HashSet::new();
    let mut after = String::new();
    for part in message.html_body().chain(message.attachments()) {
        if !seen.insert(part.id()) || !is_inline_picture(&part) {
            continue;
        }
        let named = part
            .content_id()
            .map(|id| id.trim().trim_start_matches('<').trim_end_matches('>'))
            .filter(|id| !id.is_empty())
            .map(|id| format!("cid:{id}"));
        let referenced = named.as_deref().is_some_and(|name| html.contains(name));
        if !referenced && !part.in_html_body() {
            continue;
        }
        let bytes = part.decoded();
        if bytes.len() > budget {
            continue;
        }
        budget -= bytes.len();
        let uri = format!(
            "data:{};base64,{}",
            part_type(&part),
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        match named {
            Some(name) if referenced => html = html.replace(&name, &uri),
            _ => after.push_str(&format!("<p><img src=\"{uri}\" alt=\"\"></p>")),
        }
        inlined.insert(part.id());
    }
    html + &after
}

fn is_inline_picture(part: &MessagePart<'_>) -> bool {
    part.content_type().is_some_and(|ct| {
        ct.ctype().eq_ignore_ascii_case("image")
            && ct.subtype().is_some_and(|sub| {
                INLINE_IMAGE_TYPES
                    .iter()
                    .any(|allowed| sub.eq_ignore_ascii_case(allowed))
            })
    })
}

fn part_type(part: &MessagePart<'_>) -> String {
    match part.content_type() {
        Some(ct) => match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub).to_ascii_lowercase(),
            None => ct.ctype().to_ascii_lowercase(),
        },
        None => "application/octet-stream".to_string(),
    }
}

/// What a file in an email is called: its own name, a forwarded email's
/// subject, or what it is.
fn part_name(part: &MessagePart<'_>) -> String {
    if let Some(name) = part.attachment_name().and_then(header_text) {
        return name;
    }
    if let Some(subject) = part
        .nested()
        .and_then(|nested| nested.subject().and_then(header_text))
    {
        return format!("{subject}.eml");
    }
    if part.is_message() {
        return "Forwarded email.eml".to_string();
    }
    "Unnamed file".to_string()
}

// --- saving a file an email carries ------------------------------------

/// The longest file name suggested to the save dialog, in characters.
const MAX_FILE_NAME_CHARS: usize = 180;

/// Save one of the files an email carries where the user chooses.
///
/// Rust opens the save dialog and writes the file, so neither where it goes
/// nor what is in it passes through the webview, which renders content from
/// peers. Nothing is opened: handing a file from a peer to whatever the
/// system opens it with is the user's to do, from where they saved it.
///
/// Returns the name it was saved under, or `None` when the user cancels.
#[tauri::command]
pub async fn save_email_part(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    hash: String,
    index: usize,
) -> Result<Option<String>, String> {
    let Some((mime, bytes)) = read_attachment_bytes(&state.db, &state.data_dir, &hash)? else {
        return Err("this email is not on this device yet".to_string());
    };
    if !attachment_types::is_email(&mime) {
        return Err("that attachment is not an email".to_string());
    }
    let (name, contents) = tauri::async_runtime::spawn_blocking(move || part_of(&bytes, index))
        .await
        .map_err(|e| format!("reading the email stopped unexpectedly: {e}"))??;
    let suggested = safe_file_name(&name);

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let Some(destination) = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let saved_as = picked::file_name(&destination).unwrap_or(suggested);

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || write_file(&handle, &destination, &contents))
        .await
        .map_err(|e| format!("saving the file stopped unexpectedly: {e}"))??;
    Ok(Some(saved_as))
}

/// The name and the bytes of the `index`-th file an email carries, counted
/// as `view_of` lists them.
fn part_of(bytes: &[u8], index: usize) -> Result<(String, Vec<u8>), String> {
    let message = mail_parser::MessageParser::new()
        .parse(bytes)
        .ok_or_else(|| "this email could not be read".to_string())?;
    let part = message
        .attachments()
        .nth(index)
        .ok_or_else(|| "this email has no such file".to_string())?;
    Ok((part_name(&part), part.decoded().into_owned()))
}

/// Write the file where the dialog said.
fn write_file(app: &AppHandle, destination: &FilePath, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    match destination {
        // Beside it first and renamed over it, so the destination is only
        // ever the old file or the whole new one.
        FilePath::Path(path) => write_to_path(path, contents),
        // A phone's content URI, which cannot be written beside and renamed.
        FilePath::Url(_) => {
            use tauri_plugin_fs::{FsExt, OpenOptions};
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            let mut output = app
                .fs()
                .open(destination.clone(), options)
                .map_err(|e| format!("could not open the chosen file: {e}"))?;
            output
                .write_all(contents)
                .and_then(|_| output.flush())
                .map_err(|e| format!("could not save the file: {e}"))
        }
    }
}

/// Write beside the destination first and rename over it, so the
/// destination is only ever the old file or the whole new one.
fn write_to_path(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let partial = path.with_file_name(format!(".{name}.partial"));
    let result = (|| -> std::io::Result<()> {
        let mut output = std::fs::File::create(&partial)?;
        output.write_all(contents)?;
        output.sync_all()?;
        // Closed before the rename, which Windows refuses on an open file.
        drop(output);
        std::fs::rename(&partial, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    // The name only: the error reaches the webview, and the folder is the
    // user's to know, not the page's.
    result.map_err(|e| format!("could not save {name}: {e}"))
}

/// A name a file can be saved under on any system, from whatever an email
/// called it.
///
/// Only a name: anything before the last slash of either kind is dropped, so
/// `../../x` suggests `x` and never a folder. Characters no system allows, or
/// that Windows gives a meaning to, become `_`. Names Windows reserves for
/// devices are prefixed, leading dots (a hidden file) and trailing dots and
/// spaces (which Windows drops) are taken off, and a long name is shortened
/// keeping its extension.
pub fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .to_string();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_') {
        return "file".to_string();
    }

    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    let named = if reserved {
        format!("_{trimmed}")
    } else {
        trimmed
    };

    if named.chars().count() <= MAX_FILE_NAME_CHARS {
        return named;
    }
    // Keep a short extension, and as much of the rest as fits before it.
    let (base, ext) = match named.rsplit_once('.') {
        Some((base, ext)) if !base.is_empty() && ext.chars().count() <= 10 => {
            (base.to_string(), format!(".{ext}"))
        }
        _ => (named.clone(), String::new()),
    };
    let keep = MAX_FILE_NAME_CHARS - ext.chars().count();
    format!("{}{ext}", base.chars().take(keep).collect::<String>())
}

/// A header as a note keeps it: on one line, trimmed, and not too long.
fn header_text(value: &str) -> Option<String> {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    Some(match line.char_indices().nth(MAX_HEADER_CHARS) {
        Some((end, _)) => format!("{}…", &line[..end]),
        None => line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMAIL: &[u8] = b"From: \"Ana Lima\" <ana@example.com>\r\n\
To: you@example.com\r\n\
Subject: =?UTF-8?B?Q2Fmw6k=?= plans\r\n\
Date: Tue, 3 Nov 2026 09:12:00 +0000\r\n\
\r\n\
See you there.\r\n";

    #[test]
    fn a_summary_has_the_subject_sender_and_date() {
        assert_eq!(
            summarize(EMAIL),
            EmailSummary {
                subject: Some("Café plans".into()),
                from: Some("Ana Lima <ana@example.com>".into()),
                date: Some("2026-11-03T09:12:00Z".into()),
            }
        );
    }

    #[test]
    fn a_sender_with_only_an_address_is_the_address() {
        let email = b"From: ana@example.com\r\nSubject: Hi\r\n\r\nbody";
        assert_eq!(summarize(email).from.as_deref(), Some("ana@example.com"));
    }

    #[test]
    fn missing_headers_are_missing_not_empty() {
        let email = b"From: ana@example.com\r\nSubject:   \r\n\r\nbody";
        let summary = summarize(email);
        assert_eq!(summary.subject, None);
        assert_eq!(summary.date, None);
    }

    #[test]
    fn a_folded_or_endless_header_is_kept_on_one_short_line() {
        let mut email = b"From: a@example.com\r\nSubject: one\r\n  two\r\n".to_vec();
        assert_eq!(
            summarize(&email).subject.as_deref(),
            Some("one two"),
            "folded"
        );

        email = b"From: a@example.com\r\nSubject: ".to_vec();
        email.extend(std::iter::repeat_n(b'x', 5000));
        email.extend_from_slice(b"\r\n\r\nbody");
        let subject = summarize(&email).subject.unwrap();
        assert_eq!(subject.chars().count(), MAX_HEADER_CHARS + 1);
        assert!(subject.ends_with('…'));
    }

    #[test]
    fn a_file_over_the_cap_is_refused_without_reading_it_all() {
        let big = [b'x'; 64];
        assert!(read_capped(&big[..], 63).is_err());
        assert_eq!(read_capped(&big[..], 64).unwrap().len(), 64);
    }

    // --- reading ---------------------------------------------------------

    /// A one-pixel PNG, base64, as an email carries it.
    const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    fn related(html: &str, cid: &str) -> Vec<u8> {
        format!(
            "From: Ana <ana@example.com>\r\n\
To: Bo <bo@example.com>, cy@example.com\r\n\
Cc: Di <di@example.com>\r\n\
Subject: Pictures\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/related; boundary=\"r\"\r\n\
\r\n\
--r\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
{html}\r\n\
--r\r\n\
Content-Type: image/png\r\n\
Content-Transfer-Encoding: base64\r\n\
Content-ID: <{cid}>\r\n\
Content-Disposition: inline\r\n\
\r\n\
{PIXEL}\r\n\
--r--\r\n"
        )
        .into_bytes()
    }

    #[test]
    fn a_text_email_is_read_as_text() {
        let view = view_of(EMAIL).unwrap();
        assert_eq!(view.subject.as_deref(), Some("Café plans"));
        assert_eq!(view.to, vec!["you@example.com"]);
        assert!(view.cc.is_empty());
        assert_eq!(view.html, None);
        assert_eq!(view.text.as_deref().map(str::trim), Some("See you there."));
        assert!(view.parts.is_empty());
    }

    #[test]
    fn a_picture_named_by_cid_is_put_in_the_page() {
        let view = view_of(&related("<p>Look</p><img src=\"cid:pic@x\">", "pic@x")).unwrap();
        let html = view.html.unwrap();
        assert!(
            html.contains(&format!("src=\"data:image/png;base64,{PIXEL}\"")),
            "{html}"
        );
        assert!(!html.contains("cid:"));
        assert!(view.parts.is_empty(), "a picture in the page is not a file");
        assert_eq!(view.to, vec!["Bo <bo@example.com>", "cy@example.com"]);
        assert_eq!(view.cc, vec!["Di <di@example.com>"]);
    }

    // Remote pictures are how a sender learns an email was opened. The page's
    // policy refuses them; nothing here makes them local.
    #[test]
    fn a_remote_picture_is_left_for_the_page_to_refuse() {
        let view = view_of(&related(
            "<img src=\"https://tracker.example/p.gif\">",
            "unused@x",
        ))
        .unwrap();
        let html = view.html.unwrap();
        assert!(html.contains("https://tracker.example/p.gif"));
    }

    const FILES: &[u8] = b"From: Ana <ana@example.com>\r\n\
Subject: Files\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"m\"\r\n\
\r\n\
--m\r\n\
Content-Type: text/plain\r\n\
\r\n\
Attached.\r\n\
--m\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQ=\r\n\
--m\r\n\
Content-Type: message/rfc822\r\n\
Content-Disposition: attachment\r\n\
\r\n\
From: Bo <bo@example.com>\r\n\
Subject: Earlier note\r\n\
\r\n\
Inside.\r\n\
--m--\r\n";

    #[test]
    fn files_and_forwarded_emails_are_listed() {
        let view = view_of(FILES).unwrap();
        assert_eq!(view.text.as_deref().map(str::trim), Some("Attached."));
        assert_eq!(
            view.parts,
            vec![
                EmailPart {
                    index: 0,
                    name: "report.pdf".into(),
                    mime: "application/pdf".into(),
                    size: 8,
                },
                EmailPart {
                    index: 1,
                    name: "Earlier note.eml".into(),
                    mime: "message/rfc822".into(),
                    size: view.parts[1].size,
                },
            ]
        );
    }

    #[test]
    fn a_picture_the_page_may_not_show_is_a_file() {
        // SVG is never put in the page, which would let a peer's email carry
        // a script-bearing document into it, so it is listed instead.
        let svg = String::from_utf8(related("<img src=\"cid:pic@x\">", "pic@x"))
            .unwrap()
            .replace("Content-Type: image/png", "Content-Type: image/svg+xml");
        let view = view_of(svg.as_bytes()).unwrap();
        assert!(view.html.unwrap().contains("cid:pic@x"));
        assert_eq!(view.parts.len(), 1);
        assert_eq!(view.parts[0].mime, "image/svg+xml");
    }

    // --- saving ----------------------------------------------------------

    #[test]
    fn a_file_is_saved_as_the_email_carries_it() {
        let (name, bytes) = part_of(FILES, 0).unwrap();
        assert_eq!(name, "report.pdf");
        assert_eq!(bytes, b"%PDF-1.4");

        let (name, bytes) = part_of(FILES, 1).unwrap();
        assert_eq!(name, "Earlier note.eml");
        assert!(bytes.starts_with(b"From: Bo <bo@example.com>"), "{bytes:?}");
    }

    #[test]
    fn a_file_past_the_last_is_refused() {
        assert_eq!(
            part_of(FILES, 2).unwrap_err(),
            "this email has no such file"
        );
    }

    // An email names its files, and the email is a peer's: the name must not
    // say where the file goes.
    #[test]
    fn a_name_is_only_ever_a_name() {
        assert_eq!(
            safe_file_name("../../.ssh/authorized_keys"),
            "authorized_keys"
        );
        assert_eq!(safe_file_name("..\\..\\Windows\\evil.dll"), "evil.dll");
        assert_eq!(safe_file_name("/etc/passwd"), "passwd");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name("../"), "file");
        assert_eq!(safe_file_name(".."), "file");
        assert_eq!(safe_file_name(""), "file");
    }

    #[test]
    fn a_name_has_nothing_a_system_refuses() {
        assert_eq!(safe_file_name("a:b*c?.pdf"), "a_b_c_.pdf");
        assert_eq!(safe_file_name("line\nbreak.txt"), "line_break.txt");
        assert_eq!(safe_file_name("report.pdf. . "), "report.pdf");
        assert_eq!(safe_file_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_file_name("com1"), "_com1");
        assert_eq!(safe_file_name("console.txt"), "console.txt");
        assert_eq!(safe_file_name("Café plans.pdf"), "Café plans.pdf");
        assert_eq!(safe_file_name("***"), "file");
    }

    #[test]
    fn a_long_name_keeps_its_extension() {
        let long = format!("{}.pdf", "x".repeat(500));
        let safe = safe_file_name(&long);
        assert_eq!(safe.chars().count(), MAX_FILE_NAME_CHARS);
        assert!(safe.ends_with("x.pdf"));
    }

    #[test]
    fn a_saved_file_replaces_one_there_whole() {
        let dir = std::env::temp_dir().join(format!("oyot-email-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("report.pdf");
        std::fs::write(&path, b"old").unwrap();

        write_to_path(&path, b"%PDF-1.4").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "no partial file is left behind");
    }

    #[test]
    fn a_failed_save_says_the_name_and_not_the_folder() {
        let path = std::env::temp_dir()
            .join(format!("oyot-missing-{}", uuid::Uuid::new_v4()))
            .join("report.pdf");
        let error = write_to_path(&path, b"x").unwrap_err();
        assert!(error.starts_with("could not save report.pdf"), "{error}");
        assert!(!error.contains("oyot-missing"), "{error}");
    }
}
