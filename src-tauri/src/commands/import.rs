//! Reading Markdown files in, to become notes.
//!
//! The export's split, in the other direction. The dialog opens here and the
//! files are read here, and the webview is handed their text and their names
//! and nothing else: no path crosses IPC either way, and the webview still has
//! no filesystem permission. It turns each file into a document against the
//! editor's schema, which only it holds (ADR 0013), and saves it through the
//! same path a note typed in the editor takes.
//!
//! A file is only ever read because the user picked it. An image a note
//! refers to by a path beside it is not read at all, which is what keeps this
//! command from being a way for the webview to name a file on disk.
//!
//! See docs/decisions/0029-import-markdown-files-as-notes.md.

use crate::commands::picked;
use serde::Serialize;
use std::io::Read;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// The extensions Markdown is saved under, for the dialog's filter.
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];

/// Largest file read as one note: the export's cap on a note, so a note
/// exported can always be imported again. The webview's summary says "8 MB"
/// (`src/lib/import/report.ts`) and has to change with it.
const MAX_FILE_BYTES: u64 = super::export::MAX_NOTE_BYTES as u64;

/// Most files one import reads, and most text in all of them together.
///
/// Backstops, not product limits. Everything read crosses IPC in one answer
/// and is held in the webview while it is converted, so "as many as the user
/// selected" is not an answer on its own.
const MAX_FILES: usize = 5_000;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

/// One picked file, as text.
#[derive(Debug, Serialize)]
pub struct MarkdownFile {
    /// What the file was called, for a note with no other title. Empty when
    /// the dialog's answer does not say.
    pub name: String,
    pub text: String,
}

/// Why a picked file did not become text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnreadReason {
    /// It could not be opened or read.
    Unreadable,
    /// Past `MAX_FILE_BYTES`.
    TooLarge,
    /// Not UTF-8 or UTF-16 text: an image, a PDF, a file in some other
    /// encoding.
    NotText,
}

#[derive(Debug, Serialize)]
pub struct UnreadFile {
    /// As `MarkdownFile::name`.
    pub name: String,
    pub reason: UnreadReason,
}

#[derive(Debug, Serialize)]
pub struct PickedMarkdown {
    pub files: Vec<MarkdownFile>,
    /// Files that were picked and could not be read, so the user is told
    /// which rather than finding fewer notes than they chose.
    pub unread: Vec<UnreadFile>,
}

/// Let the user pick Markdown files, and read each as text.
///
/// Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_markdown_files(app: AppHandle) -> Result<Option<PickedMarkdown>, String> {
    let dialog = app.dialog().file();
    // Only desktop filters, as for a backup. Android matches by MIME type, and
    // file managers disagree about Markdown's, so a filter there can make a
    // note impossible to pick. What a file is gets decided by reading it.
    #[cfg(desktop)]
    let dialog = dialog.add_filter("Markdown", MARKDOWN_EXTENSIONS);

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let Some(picked) = dialog.blocking_pick_files() else {
        return Ok(None);
    };
    if picked.is_empty() {
        return Ok(None);
    }
    if picked.len() > MAX_FILES {
        return Err(format!(
            "{} files is more than one import takes; pick at most {MAX_FILES}",
            picked.len()
        ));
    }

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || read_all(&handle, &picked))
        .await
        .unwrap_or_else(|e| Err(format!("reading the files stopped unexpectedly: {e}")))
        .map(Some)
}

fn read_all(app: &AppHandle, picked: &[FilePath]) -> Result<PickedMarkdown, String> {
    let mut files = Vec::with_capacity(picked.len());
    let mut unread = Vec::new();
    let mut total = 0u64;

    for path in picked {
        let name = note_file_name(path);
        let read = picked::open(app, path)
            .map_err(|e| {
                warn_log!("[import] could not open {name:?}: {e}");
                UnreadReason::Unreadable
            })
            .and_then(|file| read_text(file, MAX_FILE_BYTES));
        match read {
            Ok(text) => {
                total += text.len() as u64;
                // All or nothing: an import that quietly stopped part way
                // through would leave the user to work out which files made
                // it.
                if total > MAX_TOTAL_BYTES {
                    return Err(
                        "these files hold more than one import takes; pick fewer".to_string()
                    );
                }
                files.push(MarkdownFile { name, text });
            }
            Err(reason) => unread.push(UnreadFile { name, reason }),
        }
    }

    trace!(
        "[cmd] pick_markdown_files read {} files, {} unread, {} bytes",
        files.len(),
        unread.len(),
        total
    );
    Ok(PickedMarkdown { files, unread })
}

/// Read one file as text, refusing it once it passes `cap` bytes rather than
/// reading it all first.
fn read_text(reader: impl Read, cap: u64) -> Result<String, UnreadReason> {
    let mut bytes = Vec::new();
    reader.take(cap + 1).read_to_end(&mut bytes).map_err(|e| {
        warn_log!("[import] could not read a picked file: {e}");
        UnreadReason::Unreadable
    })?;
    if bytes.len() as u64 > cap {
        return Err(UnreadReason::TooLarge);
    }
    decode_text(bytes).ok_or(UnreadReason::NotText)
}

/// A file's bytes as text, when they are text.
///
/// UTF-8, with or without a byte order mark, is what every Markdown editor in
/// use writes. UTF-16 with a byte order mark is what "Unicode" still means to
/// older Windows tools, and it is a dozen lines. Anything else is refused
/// rather than guessed at: a wrong guess imports as a note full of the wrong
/// characters, which reads as damage, and the original is still there to
/// convert.
fn decode_text(mut bytes: Vec<u8>) -> Option<String> {
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        utf16(&bytes[2..], u16::from_le_bytes)?
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        utf16(&bytes[2..], u16::from_be_bytes)?
    } else {
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            bytes.drain(..3);
        }
        String::from_utf8(bytes).ok()?
    };
    // A NUL is what binary content has and text does not. A PNG is not valid
    // UTF-8, but plenty of other binary formats are.
    (!text.contains('\0')).then_some(text)
}

fn utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> Option<String> {
    let (pairs, odd) = bytes.as_chunks::<2>();
    if !odd.is_empty() {
        return None;
    }
    char::decode_utf16(pairs.iter().map(|&pair| unit(pair)))
        .collect::<Result<String, _>>()
        .ok()
}

/// What the webview is told a file was called, for a note with no other
/// title.
///
/// A content URI can end in nothing but a document id, and a title made of
/// that would be worse than "Untitled", so a name read out of a URI is only
/// trusted when it ends in an extension, the way a file's name does and an id
/// does not. Empty when there is nothing to trust.
fn note_file_name(path: &FilePath) -> String {
    let name = picked::file_name(path);
    match path {
        FilePath::Path(_) => name,
        FilePath::Url(_) => name.filter(|name| has_extension(name)),
    }
    .unwrap_or_default()
}

fn has_extension(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty()
            && (1..=10).contains(&ext.len())
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::path::PathBuf;

    fn utf16_bytes(text: &str, bom: [u8; 2], unit: fn(u16) -> [u8; 2]) -> Vec<u8> {
        let mut bytes = bom.to_vec();
        for code in text.encode_utf16() {
            bytes.extend_from_slice(&unit(code));
        }
        bytes
    }

    #[test]
    fn reads_utf8_with_or_without_a_byte_order_mark() {
        assert_eq!(
            decode_text(b"# Groceries\n".to_vec()).as_deref(),
            Some("# Groceries\n")
        );
        let mut marked = vec![0xEF, 0xBB, 0xBF];
        marked.extend_from_slice("# Café".as_bytes());
        assert_eq!(decode_text(marked).as_deref(), Some("# Café"));
    }

    #[test]
    fn reads_utf16_either_way_round_when_it_says_which() {
        let le = utf16_bytes("# 日記", [0xFF, 0xFE], u16::to_le_bytes);
        assert_eq!(decode_text(le).as_deref(), Some("# 日記"));
        let be = utf16_bytes("# 日記", [0xFE, 0xFF], u16::to_be_bytes);
        assert_eq!(decode_text(be).as_deref(), Some("# 日記"));
    }

    // The files a Markdown filter lets through by mistake, or that a phone,
    // which has no filter, lets the user pick.
    #[test]
    fn refuses_what_is_not_text() {
        let png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
        assert_eq!(decode_text(png), None);
        assert_eq!(decode_text(b"valid utf-8\0with a nul".to_vec()), None);
        // Latin-1, which is not guessed at.
        assert_eq!(decode_text(vec![b'c', b'a', b'f', 0xE9]), None);
    }

    #[test]
    fn refuses_utf16_that_is_cut_short_or_malformed() {
        assert_eq!(decode_text(vec![0xFF, 0xFE, b'a']), None);
        // A lone high surrogate.
        assert_eq!(decode_text(vec![0xFF, 0xFE, 0x00, 0xD8]), None);
    }

    #[test]
    fn a_file_past_the_cap_is_refused_without_reading_it_all() {
        assert_eq!(
            read_text(Cursor::new(b"12345".to_vec()), 5).as_deref(),
            Ok("12345")
        );
        assert_eq!(
            read_text(Cursor::new(b"123456".to_vec()), 5),
            Err(UnreadReason::TooLarge)
        );
    }

    #[test]
    fn a_file_is_named_by_its_path_whatever_it_is_called() {
        let path = FilePath::Path(PathBuf::from("/home/me/Notes/README"));
        assert_eq!(note_file_name(&path), "README");
    }

    #[test]
    fn a_content_uri_names_a_file_only_when_it_ends_like_one() {
        let named: FilePath = FilePath::Url(
            "content://com.android.externalstorage.documents/document/\
             primary%3ADocuments%2FGroceries.md"
                .parse()
                .unwrap(),
        );
        assert_eq!(note_file_name(&named), "Groceries.md");

        // The downloads provider names documents by number.
        let numbered: FilePath = FilePath::Url(
            "content://com.android.providers.downloads.documents/document/msf%3A31"
                .parse()
                .unwrap(),
        );
        assert_eq!(note_file_name(&numbered), "");
    }

    #[test]
    fn an_extension_is_a_short_run_of_letters_and_digits_after_a_stem() {
        assert!(has_extension("notes.md"));
        assert!(has_extension("trip.markdown"));
        assert!(!has_extension("31"));
        assert!(!has_extension(".md"));
        assert!(!has_extension("acc=1;doc=42"));
        assert!(!has_extension("v1.2 draft"));
    }

    #[test]
    fn the_reasons_reach_the_webview_as_words() {
        assert_eq!(
            serde_json::to_string(&UnreadReason::NotText).unwrap(),
            "\"not-text\""
        );
        assert_eq!(
            serde_json::to_string(&UnreadReason::TooLarge).unwrap(),
            "\"too-large\""
        );
    }
}
