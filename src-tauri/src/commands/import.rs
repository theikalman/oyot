//! Reading Markdown and HTML files in, to become notes.
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
//! See docs/decisions/0029-import-markdown-files-as-notes.md, and
//! docs/decisions/0042-import-html-files-as-editable-notes.md for HTML.

use crate::commands::picked;
use encoding_rs::Encoding;
use serde::Serialize;
use std::io::Read;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

/// The extensions Markdown is saved under, for the dialog's filter and for
/// telling which of the two a file is.
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];

/// The extensions HTML is saved under.
const HTML_EXTENSIONS: &[&str] = &["html", "htm", "xhtml", "xht"];

/// How much of an HTML file is searched for the encoding it says it is in. The
/// HTML standard asks for a declaration in the first 1024 bytes, and files
/// saved by a browser can put a comment of their own in front of it.
const DECLARATION_BYTES: usize = 4096;

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

/// What a picked file is written in, which decides how the webview reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteFormat {
    Markdown,
    Html,
}

/// One picked file, as text.
#[derive(Debug, Serialize)]
pub struct NoteFile {
    /// What the file was called, for a note with no other title. Empty when
    /// the dialog's answer does not say.
    pub name: String,
    pub text: String,
    pub format: NoteFormat,
}

/// Why a picked file did not become text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnreadReason {
    /// It could not be opened or read.
    Unreadable,
    /// Past `MAX_FILE_BYTES`.
    TooLarge,
    /// Not UTF-8 or UTF-16 text, nor HTML in an encoding it names: an image,
    /// a PDF, a file in some other encoding.
    NotText,
}

#[derive(Debug, Serialize)]
pub struct UnreadFile {
    /// As `NoteFile::name`.
    pub name: String,
    pub reason: UnreadReason,
}

#[derive(Debug, Serialize)]
pub struct PickedNotes {
    pub files: Vec<NoteFile>,
    /// Files that were picked and could not be read, so the user is told
    /// which rather than finding fewer notes than they chose.
    pub unread: Vec<UnreadFile>,
}

/// Let the user pick Markdown and HTML files, and read each as text.
///
/// Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_note_files(app: AppHandle) -> Result<Option<PickedNotes>, String> {
    let dialog = app.dialog().file();
    // Only desktop filters, as for a backup. Android matches by MIME type, and
    // file managers disagree about Markdown's, so a filter there can make a
    // note impossible to pick. What a file is gets decided by reading it.
    #[cfg(desktop)]
    let dialog = dialog.add_filter(
        "Markdown and HTML",
        &[MARKDOWN_EXTENSIONS, HTML_EXTENSIONS].concat(),
    );

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

fn read_all(app: &AppHandle, picked: &[FilePath]) -> Result<PickedNotes, String> {
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
            .and_then(|file| read_note(file, MAX_FILE_BYTES, &name));
        match read {
            Ok((text, format)) => {
                total += text.len() as u64;
                // All or nothing: an import that quietly stopped part way
                // through would leave the user to work out which files made
                // it.
                if total > MAX_TOTAL_BYTES {
                    return Err(
                        "these files hold more than one import takes; pick fewer".to_string()
                    );
                }
                files.push(NoteFile { name, text, format });
            }
            Err(reason) => unread.push(UnreadFile { name, reason }),
        }
    }

    trace!(
        "[cmd] pick_note_files read {} files, {} unread, {} bytes",
        files.len(),
        unread.len(),
        total
    );
    Ok(PickedNotes { files, unread })
}

/// Read one file as text, and say what it is written in, refusing it once it
/// passes `cap` bytes rather than reading it all first.
fn read_note(
    reader: impl Read,
    cap: u64,
    name: &str,
) -> Result<(String, NoteFormat), UnreadReason> {
    let mut bytes = Vec::new();
    reader.take(cap + 1).read_to_end(&mut bytes).map_err(|e| {
        warn_log!("[import] could not read a picked file: {e}");
        UnreadReason::Unreadable
    })?;
    if bytes.len() as u64 > cap {
        return Err(UnreadReason::TooLarge);
    }
    if let Some(text) = decode_text(&bytes) {
        let format = format_of(name, &text);
        return Ok((text, format));
    }
    // Markdown does not say what it is encoded in and HTML does, so HTML in
    // another encoding can be read without guessing.
    let start = String::from_utf8_lossy(start_of(&bytes));
    if format_of(name, &start) == NoteFormat::Html {
        if let Some(text) = decode_declared(&bytes) {
            return Ok((text, NoteFormat::Html));
        }
    }
    Err(UnreadReason::NotText)
}

/// What a file is written in: by its extension when it has one that says, and
/// otherwise by whether it opens as an HTML document does. A file picked on a
/// phone can have no name at all.
fn format_of(name: &str, text: &str) -> NoteFormat {
    if let Some((_, extension)) = name.rsplit_once('.') {
        let is = |known: &[&str]| known.iter().any(|e| e.eq_ignore_ascii_case(extension));
        if is(HTML_EXTENSIONS) {
            return NoteFormat::Html;
        }
        if is(MARKDOWN_EXTENSIONS) || extension.eq_ignore_ascii_case("txt") {
            return NoteFormat::Markdown;
        }
    }
    if opens_as_html(text) {
        NoteFormat::Html
    } else {
        NoteFormat::Markdown
    }
}

/// Whether text begins with a doctype or an `<html>` tag, after the XML
/// declaration and the comments that can come before either.
fn opens_as_html(text: &str) -> bool {
    let mut rest = text.trim_start();
    loop {
        let close = if rest.starts_with("<?xml") {
            "?>"
        } else if rest.starts_with("<!--") {
            "-->"
        } else {
            break;
        };
        match rest.split_once(close) {
            Some((_, after)) => rest = after.trim_start(),
            None => return false,
        }
    }
    let starts = |prefix: &str| {
        rest.as_bytes()
            .get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix.as_bytes()))
    };
    starts("<!doctype html")
        || (starts("<html") && rest[5..].starts_with(|c: char| c == '>' || c.is_ascii_whitespace()))
}

/// A file's bytes as text, when they are text.
///
/// UTF-8, with or without a byte order mark, is what every Markdown editor in
/// use writes. UTF-16 with a byte order mark is what "Unicode" still means to
/// older Windows tools, and it is a dozen lines. Anything else is refused
/// rather than guessed at: a wrong guess imports as a note full of the wrong
/// characters, which reads as damage, and the original is still there to
/// convert.
fn decode_text(bytes: &[u8]) -> Option<String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        utf16(rest, u16::from_le_bytes)?
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        utf16(rest, u16::from_be_bytes)?
    } else {
        let rest = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
        std::str::from_utf8(rest).ok()?.to_string()
    };
    // A NUL is what binary content has and text does not. A PNG is not valid
    // UTF-8, but plenty of other binary formats are.
    (!text.contains('\0')).then_some(text)
}

/// An HTML file's bytes as text, in the encoding the file says it is in.
///
/// Files saved before UTF-8 was everywhere, and what Word still writes, are in
/// an older encoding that their first lines name. A file that names none, or
/// is not valid in the one it names, is refused like any other.
fn decode_declared(bytes: &[u8]) -> Option<String> {
    let encoding = declared_encoding(bytes)?;
    let text = encoding.decode_without_bom_handling_and_without_replacement(bytes)?;
    (!text.contains('\0')).then(|| text.into_owned())
}

/// The encoding named in an HTML file's XML declaration or its `<meta>`.
fn declared_encoding(bytes: &[u8]) -> Option<&'static Encoding> {
    let start = String::from_utf8_lossy(start_of(bytes)).to_ascii_lowercase();
    let in_xml = start
        .trim_start()
        .strip_prefix("<?xml")
        .and_then(|rest| rest.split_once("?>"))
        .and_then(|(declaration, _)| label_after(declaration, "encoding"));
    let label = in_xml.or_else(|| {
        start
            .split("<meta")
            .skip(1)
            .filter_map(|rest| rest.split_once('>'))
            .find_map(|(attributes, _)| label_after(attributes, "charset"))
    })?;
    let encoding = Encoding::for_label(label.as_bytes())?;
    // UTF-8 has been tried by now, and UTF-16 that can be told to be UTF-16
    // has a byte order mark and has been too: a file whose tags could be read
    // well enough to get here is in neither. The last two decode bytes no
    // text was ever written in.
    let refused = [
        encoding_rs::UTF_8,
        encoding_rs::UTF_16LE,
        encoding_rs::UTF_16BE,
        encoding_rs::REPLACEMENT,
        encoding_rs::X_USER_DEFINED,
    ];
    (!refused.contains(&encoding)).then_some(encoding)
}

/// The value written after `key` and an equals sign, quoted or not.
fn label_after<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.match_indices(key).find_map(|(at, _)| {
        let value = text[at + key.len()..]
            .trim_start()
            .strip_prefix('=')?
            .trim_start()
            .trim_start_matches(['"', '\'']);
        let end = value
            .find(|c: char| c.is_ascii_whitespace() || matches!(c, '"' | '\'' | ';' | '/' | '?'))
            .unwrap_or(value.len());
        (end > 0).then(|| &value[..end])
    })
}

fn start_of(bytes: &[u8]) -> &[u8] {
    &bytes[..bytes.len().min(DECLARATION_BYTES)]
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
            decode_text(b"# Groceries\n").as_deref(),
            Some("# Groceries\n")
        );
        let mut marked = vec![0xEF, 0xBB, 0xBF];
        marked.extend_from_slice("# Café".as_bytes());
        assert_eq!(decode_text(&marked).as_deref(), Some("# Café"));
    }

    #[test]
    fn reads_utf16_either_way_round_when_it_says_which() {
        let le = utf16_bytes("# 日記", [0xFF, 0xFE], u16::to_le_bytes);
        assert_eq!(decode_text(&le).as_deref(), Some("# 日記"));
        let be = utf16_bytes("# 日記", [0xFE, 0xFF], u16::to_be_bytes);
        assert_eq!(decode_text(&be).as_deref(), Some("# 日記"));
    }

    // The files a Markdown filter lets through by mistake, or that a phone,
    // which has no filter, lets the user pick.
    #[test]
    fn refuses_what_is_not_text() {
        let png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
        assert_eq!(decode_text(&png), None);
        assert_eq!(decode_text(b"valid utf-8\0with a nul"), None);
        // Latin-1, which is not guessed at.
        assert_eq!(decode_text(&[b'c', b'a', b'f', 0xE9]), None);
    }

    #[test]
    fn refuses_utf16_that_is_cut_short_or_malformed() {
        assert_eq!(decode_text(&[0xFF, 0xFE, b'a']), None);
        // A lone high surrogate.
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x00, 0xD8]), None);
    }

    #[test]
    fn a_file_past_the_cap_is_refused_without_reading_it_all() {
        assert_eq!(
            read_note(Cursor::new(b"12345".to_vec()), 5, "a.md"),
            Ok(("12345".to_string(), NoteFormat::Markdown))
        );
        assert_eq!(
            read_note(Cursor::new(b"123456".to_vec()), 5, "a.md"),
            Err(UnreadReason::TooLarge)
        );
    }

    #[test]
    fn a_file_is_what_its_extension_says() {
        assert_eq!(format_of("page.HTML", "# Trip"), NoteFormat::Html);
        assert_eq!(format_of("page.htm", ""), NoteFormat::Html);
        // Markdown can open with HTML and still be Markdown.
        assert_eq!(
            format_of("notes.md", "<html>\n\n# Trip"),
            NoteFormat::Markdown
        );
        assert_eq!(
            format_of("notes.txt", "<!doctype html>"),
            NoteFormat::Markdown
        );
    }

    #[test]
    fn a_file_whose_name_does_not_say_is_html_when_it_opens_as_html() {
        assert_eq!(format_of("", "\n<!DOCTYPE html><p>hi"), NoteFormat::Html);
        assert_eq!(format_of("page", "<html lang=en>"), NoteFormat::Html);
        assert_eq!(
            format_of(
                "",
                "<?xml version=\"1.0\"?>\n<!-- saved from url=(0014)about:internet -->\n<html>"
            ),
            NoteFormat::Html
        );
        assert_eq!(format_of("", "# Trip"), NoteFormat::Markdown);
        assert_eq!(format_of("", "<p>hi</p>"), NoteFormat::Markdown);
        assert_eq!(format_of("", "<htmlish>"), NoteFormat::Markdown);
        assert_eq!(format_of("", "<!-- never closed"), NoteFormat::Markdown);
        // Cut short, or not a whole character where the prefix would end.
        assert_eq!(format_of("", "<htm"), NoteFormat::Markdown);
        assert_eq!(format_of("", "<!doctype 日記"), NoteFormat::Markdown);
    }

    fn read(bytes: &[u8], name: &str) -> Result<(String, NoteFormat), UnreadReason> {
        read_note(Cursor::new(bytes.to_vec()), 1024 * 1024, name)
    }

    #[test]
    fn html_is_read_in_the_encoding_it_names() {
        let html = |text: &str| Ok((text.to_string(), NoteFormat::Html));
        // As Word writes it, unquoted and with the `<meta>` split over lines.
        assert_eq!(
            read(
                b"<html><meta http-equiv=Content-Type\ncontent=\"text/html; charset=windows-1252\">caf\xE9 \x93hi\x94",
                "word.htm"
            ),
            html("<html><meta http-equiv=Content-Type\ncontent=\"text/html; charset=windows-1252\">café “hi”")
        );
        assert_eq!(
            read(b"<meta charset='Shift_JIS'>\x93\xFA\x8BL", "diary.html"),
            html("<meta charset='Shift_JIS'>日記")
        );
        assert_eq!(
            read(
                b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><html>caf\xE9",
                ""
            ),
            html("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><html>café")
        );
    }

    #[test]
    fn html_that_is_utf8_is_read_as_utf8_whatever_it_names() {
        assert_eq!(
            read("<meta charset=iso-8859-1>café".as_bytes(), "a.html"),
            Ok((
                "<meta charset=iso-8859-1>café".to_string(),
                NoteFormat::Html
            ))
        );
    }

    #[test]
    fn html_in_an_encoding_it_does_not_name_is_refused() {
        for bytes in [
            b"<html>caf\xE9".as_slice(),
            b"<meta charset=utf-8>caf\xE9",
            b"<meta charset=utf-16le>caf\xE9",
            b"<meta charset=x-user-defined>caf\xE9",
            b"<meta charset=no-such-thing>caf\xE9",
            b"<meta charset=>caf\xE9",
            b"<meta name=charset>caf\xE9",
            // Not valid in the encoding it names.
            b"<meta charset=shift_jis>\x93",
            b"<meta charset=windows-1252>caf\xE9\0",
            // Outside a `<meta>`, or further in than it may be.
            b"<html>charset=windows-1252 caf\xE9",
        ] {
            assert_eq!(read(bytes, "a.html"), Err(UnreadReason::NotText));
        }
        let mut far = b"<html>".to_vec();
        far.extend(std::iter::repeat_n(b' ', DECLARATION_BYTES));
        far.extend(b"<meta charset=windows-1252>caf\xE9");
        assert_eq!(read(&far, "a.html"), Err(UnreadReason::NotText));
    }

    #[test]
    fn markdown_that_names_an_encoding_is_not_read_in_it() {
        assert_eq!(
            read(b"<meta charset=windows-1252>caf\xE9", "a.md"),
            Err(UnreadReason::NotText)
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
    fn the_format_reaches_the_webview_as_a_word() {
        assert_eq!(
            serde_json::to_string(&[NoteFormat::Markdown, NoteFormat::Html]).unwrap(),
            "[\"markdown\",\"html\"]"
        );
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
