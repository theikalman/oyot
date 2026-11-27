//! Emails attached to notes (docs/plans/email-attachments.md).
//!
//! An email is stored in the attachment store like an image, as
//! `<hash>.eml`, and a note holds only `oyot-attachment://<hash>` and the
//! few headers its chip shows. The page never reads the stored file: what it
//! shows of an email is what this module parses out of it.

use crate::attachment_types::{self, EMAIL_MIME, MAX_EMAIL_BYTES};
use crate::commands::attachments::{announce_image, store_attachment};
use crate::commands::picked;
use crate::db::AppState;
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
        .and_then(|mailbox| {
            let name = mailbox.name().map(str::trim).filter(|s| !s.is_empty());
            let address = mailbox.address().map(str::trim).filter(|s| !s.is_empty());
            match (name, address) {
                (Some(name), Some(address)) => Some(format!("{name} <{address}>")),
                (Some(only), None) | (None, Some(only)) => Some(only.to_string()),
                (None, None) => None,
            }
        });
    EmailSummary {
        subject: message.subject().and_then(header_text),
        from: from.as_deref().and_then(header_text),
        date: message
            .date()
            .filter(|date| date.is_valid())
            .map(|date| date.to_rfc3339()),
    }
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
}
