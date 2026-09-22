//! Writing every note out as an archive of Markdown files.
//!
//! The split with the frontend is the one the rest of the app already has:
//! content lives in the CRDT and only the webview can render it (ADR 0013), so
//! the webview produces the Markdown, and Rust does everything that touches
//! the filesystem. The webview has no filesystem permission at all, and this
//! command does not give it one - it names no path the caller supplied, and
//! the only path it writes to is the one the user picked in the save dialog.
//!
//! See docs/decisions/0021-export-notes-as-a-markdown-archive.md.

use crate::db::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

/// One note, as the webview rendered it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNote {
    /// The file to write it as, inside `notes/`. A bare filename; see
    /// `validate_entry_name` for what that is allowed to be.
    pub name: String,
    pub markdown: String,
    /// When the note was last saved, in epoch milliseconds, so the extracted
    /// file is dated when it was written rather than when it was exported.
    pub updated_at: i64,
}

/// One attachment, and the file it is written as inside `attachments/`.
///
/// The name is decided here rather than in the webview because the extension
/// follows the stored mime type, and `attachments.rs` is what maps one to the
/// other. The frontend asks for this list before it renders anything, so the
/// links it writes and the files in the archive are named by the same code.
#[derive(Debug, Serialize)]
pub struct ExportAttachment {
    pub hash: String,
    pub filename: String,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    /// Where it was written, for the confirmation message.
    pub path: String,
    pub note_count: usize,
    pub attachment_count: usize,
}

/// How much Markdown we will accept for one note, and for the whole call.
///
/// A backstop, not a product limit. The bytes arrive over IPC from the
/// untrusted surface, and they are held in memory while the archive is
/// written, so "as much as the webview cares to send" is not an answer.
const MAX_NOTE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_NOTE_BYTES: usize = 256 * 1024 * 1024;
const MAX_NOTES: usize = 100_000;

/// Longest entry name we will write. Well inside the 255-byte limit that
/// every filesystem an extractor might unpack onto shares.
const MAX_ENTRY_NAME_BYTES: usize = 200;

/// Whether a name from the webview is a plain filename.
///
/// This is the whole of the zip-slip defence. An entry name is a path to
/// whatever unpacks the archive, so `../../.ssh/authorized_keys` inside a zip
/// is a real attack on the person who extracts it, and the names here are
/// chosen by the untrusted surface. Rather than sanitising - which invites
/// arguments about whether the sanitiser is complete - anything that is not
/// recognisably a single filename is refused outright and the export fails
/// loudly.
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("an export entry has no name".to_string());
    }
    if name.len() > MAX_ENTRY_NAME_BYTES {
        return Err(format!(
            "export entry name is too long: {} bytes",
            name.len()
        ));
    }
    if !name.ends_with(".md") || name.len() == 3 {
        return Err(format!("export entry {name:?} is not a .md file"));
    }
    // A leading dot hides the file on Unix, and "." / ".." are not names.
    if name.starts_with('.') {
        return Err(format!("export entry {name:?} starts with a dot"));
    }
    if name.trim() != name {
        return Err(format!("export entry {name:?} is padded with whitespace"));
    }
    for ch in name.chars() {
        // Separators on any platform, the Windows drive separator, the
        // wildcards and redirects a shell would expand, and every control
        // character.
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            return Err(format!("export entry {name:?} contains {ch:?}"));
        }
    }
    Ok(())
}

/// A content hash, as everything content-addressed in this app spells one.
fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{hash:?} is not a content hash"))
    }
}

/// An epoch-milliseconds stamp as a zip entry timestamp.
///
/// Zip stores a local-time date with no zone, which is why this converts to
/// local time rather than UTC: the date an extractor shows should be the date
/// the app showed. `None` for anything the format cannot hold - it only
/// reaches back to 1980, and a row written under a badly wrong device clock
/// should cost the entry its timestamp and nothing more.
fn zip_time(ms: i64) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let at = chrono::DateTime::from_timestamp_millis(ms)?.with_timezone(&chrono::Local);
    zip::DateTime::from_date_and_time(
        u16::try_from(at.year()).ok()?,
        at.month() as u8,
        at.day() as u8,
        at.hour() as u8,
        at.minute() as u8,
        at.second() as u8,
    )
    .ok()
}

/// A file's own modification time, in epoch milliseconds.
fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since_epoch.as_millis()).ok()
}

/// Which attachments an export can include, and what each will be called.
///
/// Called before the notes are rendered: the frontend needs the filenames to
/// write the image links, and a hash that is not in this list is one whose
/// bytes are not on this device, which the note has to say rather than link to.
#[tauri::command]
pub fn list_export_attachments(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ExportAttachment>, String> {
    let rows = {
        let db = state.db.lock();
        super::attachments::referenced_attachments(&db)?
    };
    let mut out = Vec::with_capacity(rows.len());
    for (hash, mime_type, _) in rows {
        if let Some(filename) = super::attachments::export_filename(&hash, &mime_type) {
            out.push(ExportAttachment { hash, filename });
        }
    }
    Ok(out)
}

/// Write every note, and the images they embed, to a zip the user picks.
///
/// Returns `None` when the user cancels the dialog.
#[tauri::command]
pub async fn export_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    notes: Vec<ExportNote>,
    attachments: Vec<String>,
) -> Result<Option<ExportResult>, String> {
    use tauri_plugin_dialog::DialogExt;

    if notes.is_empty() {
        return Err("there is nothing to export".to_string());
    }
    if notes.len() > MAX_NOTES {
        return Err(format!("too many notes to export: {}", notes.len()));
    }

    // Everything the caller supplied is checked before the user is asked
    // where to put it. A dialog that opens and then fails is worse than one
    // that never opened.
    let mut seen = HashSet::with_capacity(notes.len());
    let mut total = 0usize;
    for note in &notes {
        validate_entry_name(&note.name)?;
        if !seen.insert(note.name.as_str()) {
            return Err(format!("two notes would be written as {:?}", note.name));
        }
        if note.markdown.len() > MAX_NOTE_BYTES {
            return Err(format!("{:?} is too large to export", note.name));
        }
        total += note.markdown.len();
        if total > MAX_TOTAL_NOTE_BYTES {
            return Err("the export is too large".to_string());
        }
    }
    for hash in &attachments {
        validate_hash(hash)?;
    }

    // Resolved before the dialog for the same reason, and the lock is dropped
    // before any file is touched: a long write must not block a save.
    let wanted: HashSet<&str> = attachments.iter().map(String::as_str).collect();
    let files: Vec<(String, String)> = {
        let db = state.db.lock();
        super::attachments::referenced_attachments(&db)?
    }
    .into_iter()
    .filter(|(hash, _, _)| wanted.contains(hash.as_str()))
    .filter_map(|(hash, mime_type, local_path)| {
        super::attachments::export_filename(&hash, &mime_type).map(|name| (name, local_path))
    })
    .collect();

    let suggested = format!(
        "oyot-export-{}.zip",
        chrono::Local::now().format("%Y-%m-%d")
    );

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .add_filter("Zip archive", &["zip"])
        .blocking_save_file();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let destination = picked
        .into_path()
        .map_err(|e| format!("could not use the chosen location: {e}"))?;

    match write_archive(&destination, &notes, &files, &state.data_dir) {
        Ok(attachment_count) => {
            trace!(
                "[cmd] export_notes wrote {} notes and {} attachments",
                notes.len(),
                attachment_count
            );
            Ok(Some(ExportResult {
                path: destination.to_string_lossy().to_string(),
                note_count: notes.len(),
                attachment_count,
            }))
        }
        Err(e) => {
            // A half-written archive is worse than none: it opens, it looks
            // like an export, and it is missing notes without saying so.
            let _ = std::fs::remove_file(&destination);
            Err(e)
        }
    }
}

/// Build the archive. Returns how many attachments actually made it in.
fn write_archive(
    destination: &Path,
    notes: &[ExportNote],
    files: &[(String, String)],
    data_dir: &Path,
) -> Result<usize, String> {
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(destination)
        .map_err(|e| format!("could not create {}: {e}", destination.display()))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));

    let text_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        // Markdown is small and compresses well; an image is already
        // compressed and running deflate over it costs time for nothing.
        .large_file(false);
    let binary_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(false);

    for note in notes {
        let options = match zip_time(note.updated_at) {
            Some(at) => text_options.last_modified_time(at),
            None => text_options,
        };
        zip.start_file(format!("notes/{}", note.name), options)
            .map_err(|e| format!("could not add {}: {e}", note.name))?;
        zip.write_all(note.markdown.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", note.name))?;
    }

    let mut written = 0;
    for (filename, local_path) in files {
        let source = data_dir.join(local_path);
        // A row whose file has gone is skipped rather than fatal: the note
        // still exports, with a link to an image that is not there, which is
        // the same thing the app itself shows.
        let bytes = match std::fs::read(&source) {
            Ok(bytes) => bytes,
            Err(e) => {
                warn_log!("[export] skipping {}: {e}", source.display());
                continue;
            }
        };
        let options = match modified_ms(&source).and_then(zip_time) {
            Some(at) => binary_options.last_modified_time(at),
            None => binary_options,
        };
        zip.start_file(format!("attachments/{filename}"), options)
            .map_err(|e| format!("could not add {filename}: {e}"))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("could not write {filename}: {e}"))?;
        written += 1;
    }

    // Finishing is what writes the central directory, and a BufWriter has to
    // be flushed after it: without both, the file exists and no extractor
    // will open it.
    let mut buffered = zip
        .finish()
        .map_err(|e| format!("could not finish the archive: {e}"))?;
    buffered
        .flush()
        .map_err(|e| format!("could not finish writing the archive: {e}"))?;

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_markdown_filename() {
        assert!(validate_entry_name("groceries.md").is_ok());
        assert!(validate_entry_name("22-sep-2026.md").is_ok());
        // Non-ASCII is a name, not an attack: a title in any script has to
        // survive being exported.
        assert!(validate_entry_name("café-notes.md").is_ok());
    }

    #[test]
    fn refuses_anything_that_is_not_one_filename() {
        for name in [
            "",
            "notes.txt",
            ".md",
            "../escape.md",
            "a/b.md",
            "a\\b.md",
            "C:notes.md",
            ".hidden.md",
            " padded.md",
            "wild*.md",
        ] {
            assert!(
                validate_entry_name(name).is_err(),
                "{name:?} should have been refused"
            );
        }
    }

    #[test]
    fn refuses_a_name_carrying_a_control_character() {
        assert!(validate_entry_name("news\nline.md").is_err());
        assert!(validate_entry_name("nul\0.md").is_err());
    }

    #[test]
    fn refuses_a_name_past_the_length_cap() {
        let long = format!("{}.md", "a".repeat(MAX_ENTRY_NAME_BYTES));
        assert!(validate_entry_name(&long).is_err());
    }

    /// A scratch directory of our own, so the test does not need a
    /// dev-dependency to get one.
    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("oyot-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The point of the crate is that the container is right, so the test reads
    // it back rather than checking the file is non-empty.
    #[test]
    fn writes_notes_and_attachments_an_extractor_can_open() {
        let dir = scratch();
        let data_dir = dir.join("data");
        std::fs::create_dir_all(data_dir.join("attachments")).unwrap();
        std::fs::write(data_dir.join("attachments/pic.png"), b"not really a png").unwrap();

        let notes = vec![
            ExportNote {
                name: "groceries.md".to_string(),
                markdown: "# Groceries\n\nmilk\n".to_string(),
                updated_at: 1_790_000_000_000,
            },
            ExportNote {
                name: "café.md".to_string(),
                markdown: "# Café\n".to_string(),
                updated_at: 0,
            },
        ];
        let files = vec![("abc.png".to_string(), "attachments/pic.png".to_string())];

        let destination = dir.join("out.zip");
        let written = write_archive(&destination, &notes, &files, &data_dir).unwrap();
        assert_eq!(written, 1);

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&destination).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_string).collect();
        assert!(names.contains(&"notes/groceries.md".to_string()));
        assert!(names.contains(&"notes/café.md".to_string()));
        assert!(names.contains(&"attachments/abc.png".to_string()));

        let mut entry = archive.by_name("notes/groceries.md").unwrap();
        let mut body = String::new();
        std::io::Read::read_to_string(&mut entry, &mut body).unwrap();
        assert_eq!(body, "# Groceries\n\nmilk\n");

        drop(entry);

        // The note's own date, not the export's, and a stamp the format
        // cannot hold costs that entry its date and nothing else.
        let dated = archive.by_name("notes/groceries.md").unwrap();
        assert_eq!(
            dated.last_modified().unwrap(),
            zip_time(1_790_000_000_000).unwrap()
        );
        drop(dated);
        assert!(zip_time(0).is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // A row can outlive its file - a peer's attachment that was collected, or
    // a store someone tidied by hand. The note still has to export.
    #[test]
    fn skips_an_attachment_whose_file_has_gone() {
        let dir = scratch();
        let notes = vec![ExportNote {
            name: "note.md".to_string(),
            markdown: "hello\n".to_string(),
            updated_at: 1_790_000_000_000,
        }];
        let files = vec![("gone.png".to_string(), "attachments/gone.png".to_string())];

        let destination = dir.join("out.zip");
        let written = write_archive(&destination, &notes, &files, &dir.join("data")).unwrap();
        assert_eq!(written, 0);

        let archive = zip::ZipArchive::new(std::fs::File::open(&destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_accepts_a_hex_content_hash() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        assert!(validate_hash(&"A".repeat(64)).is_ok());
        assert!(validate_hash(&"a".repeat(63)).is_err());
        assert!(validate_hash("../../etc/passwd").is_err());
        assert!(validate_hash(&"z".repeat(64)).is_err());
    }
}
