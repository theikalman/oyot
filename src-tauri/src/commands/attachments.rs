use crate::db::AppState;
use crate::indexer;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::attachment_types::{self, extension_for, kind_name, max_bytes_for, sniff};

/// Largest image we will take in, from disk or from a paste. Mirrors the
/// check the editor does before it calls in, and is the backstop for the peer
/// transfer path, which has no UI in front of it.
pub use crate::attachment_types::MAX_IMAGE_BYTES;

/// The file an attachment is written as outside the app.
///
/// The same `<hash>.<ext>` it has in the attachment store, and `None` for a
/// stored mime type this build has no extension for. Exposed so the export
/// command and the Markdown links inside the archive are named by one
/// function rather than two that have to agree.
pub fn export_filename(hash: &str, mime_type: &str) -> Option<String> {
    Some(format!("{hash}.{}", extension_for(mime_type)?))
}

fn filename_for(hash: &str, mime_type: &str) -> Result<String, String> {
    let ext = extension_for(mime_type)
        .ok_or_else(|| format!("unsupported attachment type: {mime_type}"))?;
    Ok(format!("{hash}.{ext}"))
}

const UNSUPPORTED_DATA: &str = "unsupported attachment data: only PNG, JPEG, GIF, WebP and emails";

fn mime_for_extension(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Write bytes into the attachment store and record the row. Shared by every
/// entry point so the size cap, the type allowlist and the content address are
/// enforced in exactly one place.
pub(crate) fn store_attachment(
    state: &AppState,
    bytes: &[u8],
    mime_type: &str,
) -> Result<StoredImage, String> {
    store_attachment_at(&state.db, &state.data_dir, bytes, mime_type)
}

/// `store_attachment`, given the database and the data directory rather than
/// the app's state, for the sync engine, which runs without Tauri on a phone's
/// background run (ADR 0031, decision 8).
pub(crate) fn store_attachment_at(
    db: &parking_lot::Mutex<Connection>,
    data_dir: &std::path::Path,
    bytes: &[u8],
    mime_type: &str,
) -> Result<StoredImage, String> {
    // The declared type sets the cap, so nothing larger than its type allows
    // is read for what it is. A type the store does not take stops here.
    let cap = max_bytes_for(mime_type)
        .ok_or_else(|| format!("unsupported attachment type: {mime_type}"))?;
    let kind = kind_name(mime_type);
    if bytes.is_empty() {
        return Err(format!("{kind} is empty"));
    }
    if bytes.len() > cap {
        return Err(format!(
            "{kind} is {} bytes, over the {cap} byte limit",
            bytes.len()
        ));
    }

    // The bytes decide the type, not the caller. A declared type that
    // disagrees means the caller is wrong or lying, and either way this is
    // not something to store under a name that misdescribes it.
    let detected = sniff(bytes).ok_or_else(|| UNSUPPORTED_DATA.to_string())?;
    if extension_for(mime_type) != extension_for(detected) {
        return Err(format!(
            "content is {detected}, which does not match the declared {mime_type}"
        ));
    }
    let mime_type = detected;

    let hash = sha256_hex(bytes);
    let filename = filename_for(&hash, mime_type)?;

    let attachments_dir = data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    std::fs::write(attachments_dir.join(&filename), bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("attachments/{filename}");
    let now = current_timestamp();

    let db = db.lock();
    db.execute(
        "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
        params![&hash, mime_type, &relative_path, now],
    )
    .map_err(|e| e.to_string())?;

    // An email's words, for search. Every way an email arrives comes through
    // here: the picker, sync and a restore. Not being searchable is no reason
    // to lose the email, so a failure is only reported.
    if attachment_types::is_email(mime_type) {
        if let Err(e) = crate::commands::email::index_email_text(&db, &hash, bytes) {
            warn_log!("[email] could not index {hash} for search: {e}");
        }
    }

    Ok(StoredImage {
        hash,
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
    })
}

/// Store bytes that have already been held to their hash, as the backup
/// importer holds them. The type still comes from the bytes, not from the
/// name the archive gave the file, which decides nothing.
pub(crate) fn store_checked_attachment(
    state: &AppState,
    bytes: &[u8],
) -> Result<StoredImage, String> {
    store_checked_attachment_at(&state.db, &state.data_dir, bytes)
}

fn store_checked_attachment_at(
    db: &parking_lot::Mutex<Connection>,
    data_dir: &std::path::Path,
    bytes: &[u8],
) -> Result<StoredImage, String> {
    let mime_type = sniff(bytes).ok_or_else(|| UNSUPPORTED_DATA.to_string())?;
    store_attachment_at(db, data_dir, bytes, mime_type)
}

/// Every attachment this device holds in full whose file is actually there.
///
/// A row can outlive its file. Counting such a row as held would stop an
/// import from putting back the one thing it could restore.
pub(crate) fn held_attachments(
    db: &Connection,
    data_dir: &std::path::Path,
) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = db
        .prepare(
            "SELECT hash, local_path FROM attachments \
             WHERE is_fully_downloaded = 1 AND local_path IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|(_, local_path)| data_dir.join(local_path).is_file())
        .map(|(hash, _)| hash)
        .collect())
}

#[derive(Debug, serde::Serialize)]
pub struct StoredImage {
    pub hash: String,
    pub mime_type: String,
    pub size: i64,
}

/// Let the user pick an image, and store it.
///
/// The dialog is opened here rather than in the webview, so the chosen path
/// never crosses IPC. It used to: the webview called the dialog plugin and
/// handed the resulting path to Rust to read. The docstring claimed the path
/// "comes from the dialog plugin, i.e. from the user", but the command had no
/// way to know that, and the security model treats the webview as untrusted
/// precisely because it renders documents and images that arrive from peers.
/// A script there could name any file on disk and have it copied into the
/// attachment store, from where it is advertised to every paired device.
///
/// Reading the bytes here also means the frontend needs no filesystem
/// permission at all, and a 10MB image never crosses IPC as base64.
///
/// Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_and_import_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<StoredImage>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Blocking, which is why this command is async: Tauri runs an async
    // command off the main thread, which is where the plugin requires this
    // call to be.
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .blocking_pick_file();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("could not read the chosen file: {e}"))?;

    // Checked before reading, so an enormous file is never loaded only to be
    // rejected.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_IMAGE_BYTES {
        return Err(format!(
            "image is {} bytes, over the {} byte limit",
            meta.len(),
            MAX_IMAGE_BYTES
        ));
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // The extension is a hint for the dialog filter; `store_attachment`
    // decides the real type from the bytes.
    let declared = mime_for_extension(&path)
        .ok_or_else(|| "unsupported image type: only PNG, JPEG, GIF and WebP".to_string())?;
    let stored = store_attachment(&state, &bytes, declared)?;
    announce_image(&state, &stored);
    Ok(Some(stored))
}

/// Tell connected devices about an image just added here, so they fetch it
/// without waiting for their next connection. Sent before the note that
/// embeds it is saved: a peer that fetches it first has it ready when the
/// note arrives.
pub(crate) fn announce_image(state: &AppState, image: &StoredImage) {
    crate::sync::announce(
        &state.app_handle,
        crate::sync::protocol::Message::AttachManifest {
            items: vec![crate::sync::protocol::AttachmentEntry {
                hash: image.hash.clone(),
                mime: image.mime_type.clone(),
                size: image.size.max(0) as u64,
            }],
        },
    );
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Store an image the webview already holds in memory: a paste or a drag-drop,
/// where the bytes come from a Blob and base64 over IPC is the only route.
#[tauri::command]
pub fn save_image(
    state: tauri::State<'_, AppState>,
    image_data: String,
    mime_type: String,
) -> Result<String, String> {
    use base64::Engine;
    // Pictures only: an email comes in by its own command, which can tell it
    // where it came from.
    if !attachment_types::is_image(&mime_type) {
        return Err(format!("unsupported image type: {mime_type}"));
    }
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_data)
        .map_err(|e| e.to_string())?;

    let stored = store_attachment(&state, &image_bytes, &mime_type)?;
    announce_image(&state, &stored);
    Ok(stored.hash)
}

#[tauri::command]
/// Documents whose derived rows predate the indexer recording attachments.
///
/// Collection is unsafe while any exist: their images are on the page but not
/// in `document_attachments`, so they would look unreferenced. The frontend
/// renders each of these and saves an index, which is the only way to build
/// one for content this device has never displayed.
pub fn unindexed_document_ids(db: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id FROM documents
              WHERE is_deleted = 0
                AND length(crdt_state) > 2
                AND index_version < ?1",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![indexer::INDEX_VERSION], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

#[tauri::command]
pub fn list_unindexed_documents(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock();
    unindexed_document_ids(&db)
}

/// Attachments no live document embeds any more, with their stored paths.
pub fn unreferenced_attachments(db: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = db
        .prepare(
            "SELECT a.hash, a.local_path FROM attachments a
              WHERE a.local_path IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM document_attachments r
                                 JOIN documents d ON d.id = r.document_id
                                WHERE r.hash = a.hash AND d.is_deleted = 0)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Delete the blobs no document refers to any more.
///
/// This used to delete rows with `is_fully_downloaded = 0`, which nothing
/// writes: `store_attachment` always writes 1. So it collected nothing, while
/// reporting a count and a toast, and an image removed from every note stayed
/// on disk and kept being advertised to peers. There was no reference data to
/// do better with until now.
///
/// Returns 0 without touching anything while any document is still unindexed,
/// because an unindexed document's images look unreferenced.
#[tauri::command]
pub fn cleanup_orphaned_images(state: tauri::State<'_, AppState>) -> Result<i32, String> {
    collect_orphans(&state.db, &state.data_dir)
}

/// `cleanup_orphaned_images`, given the database and the data directory.
fn collect_orphans(
    db: &parking_lot::Mutex<Connection>,
    data_dir: &std::path::Path,
) -> Result<i32, String> {
    let orphaned = {
        let db = db.lock();
        if !unindexed_document_ids(&db)?.is_empty() {
            trace!("[cmd] cleanup_orphaned_images skipped, documents still to index");
            return Ok(0);
        }
        unreferenced_attachments(&db)?
    };
    if orphaned.is_empty() {
        return Ok(0);
    }

    for (_, path) in &orphaned {
        let full_path = data_dir.join(path);
        if full_path.exists() {
            let _ = std::fs::remove_file(&full_path);
        }
    }

    let db = db.lock();
    let mut removed = 0;
    for (hash, _) in &orphaned {
        // The row goes with the file. Leaving it would keep the attachment in
        // our manifest with no bytes behind it.
        removed += db
            .execute("DELETE FROM attachments WHERE hash = ?", params![hash])
            .map_err(|e| e.to_string())?;
        // And an email's words with it, which no note can be found by now.
        db.execute("DELETE FROM email_search WHERE hash = ?", params![hash])
            .map_err(|e| e.to_string())?;
    }

    Ok(removed as i32)
}

#[tauri::command]
pub fn get_attachment_info(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<AttachmentInfoResponse>, String> {
    let db = state.db.lock();
    let result = db.query_row(
        "SELECT hash, mime_type, local_path, is_fully_downloaded FROM attachments WHERE hash = ?",
        params![&hash],
        |row| {
            let local_path: Option<String> = row.get(2)?;
            let is_downloaded: i32 = row.get(3)?;
            Ok(AttachmentInfoResponse {
                hash: row.get(0)?,
                mime_type: row.get(1)?,
                local_path,
                is_fully_downloaded: is_downloaded == 1,
            })
        },
    );

    match result {
        Ok(info) => Ok(Some(info)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(serde::Serialize)]
pub struct AttachmentInfoResponse {
    pub hash: String,
    pub mime_type: String,
    pub local_path: Option<String>,
    pub is_fully_downloaded: bool,
}

/// Where an image's bytes are on this device, for the page to show it.
///
/// Images only. The page shows an email through what Rust parses out of it,
/// never by loading the stored file, so nothing in the webview has a use for
/// an email's address in the asset protocol.
#[tauri::command]
pub fn get_local_blob_url(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock();
    Ok(local_image_path(&db, &state.data_dir, &hash)?
        .map(|path| path.to_string_lossy().to_string()))
}

fn local_image_path(
    db: &Connection,
    data_dir: &std::path::Path,
    hash: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT mime_type, local_path FROM attachments \
             WHERE hash = ? AND is_fully_downloaded = 1 AND local_path IS NOT NULL",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row
        .filter(|(mime_type, _)| attachment_types::is_image(mime_type))
        .map(|(_, relative_path)| data_dir.join(relative_path)))
}

// --- peer-to-peer attachment transfer -------------------------------------

#[derive(serde::Serialize)]
pub struct AttachmentManifestEntry {
    pub hash: String,
    pub mime_type: String,
    pub size: i64,
}

// Every attachment this device holds in full - advertised to a peer on connect
// so it can pull the ones it is missing. Mirrors the document `sync-manifest`.
/// Every attachment a live document still embeds, and that we hold in full:
/// `(hash, mime_type, local_path)`.
///
/// Only what a live document still embeds. Advertising everything we hold
/// means a peer that has collected an orphan pulls it straight back from us on
/// the next connect, and collects it again: the two devices trade the same
/// dead blob forever. ADR 0005 deferred this scan; collecting unreferenced
/// blobs is what makes it necessary.
///
/// Shared with the exporter, which wants exactly the same set for the same
/// reason - a blob no note refers to is not part of the notes - and a second
/// copy of this query would be one to keep in step by hand.
pub fn referenced_attachments(db: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = db
        .prepare(
            "SELECT a.hash, a.mime_type, a.local_path FROM attachments a \
             WHERE a.is_fully_downloaded = 1 AND a.local_path IS NOT NULL \
               AND EXISTS (SELECT 1 FROM document_attachments r \
                            JOIN documents d ON d.id = r.document_id \
                           WHERE r.hash = a.hash AND d.is_deleted = 0)",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Every referenced image this device holds in full, with its size.
pub(crate) fn attachment_manifest(
    db: &parking_lot::Mutex<Connection>,
    data_dir: &std::path::Path,
) -> Result<Vec<AttachmentManifestEntry>, String> {
    let rows = {
        let db = db.lock();
        referenced_attachments(&db)?
    };

    let mut out = Vec::new();
    for (hash, mime_type, local_path) in rows {
        let size = data_dir
            .join(&local_path)
            .metadata()
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        if size == 0 {
            continue; // file vanished under us - do not advertise it
        }
        out.push(AttachmentManifestEntry {
            hash,
            mime_type,
            size,
        });
    }
    Ok(out)
}

/// An image's type and bytes, when this device holds it in full.
pub(crate) fn read_attachment_bytes(
    db: &parking_lot::Mutex<Connection>,
    data_dir: &std::path::Path,
    hash: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let row: Option<(String, String)> = {
        let db = db.lock();
        db.query_row(
            "SELECT mime_type, local_path FROM attachments \
             WHERE hash = ? AND is_fully_downloaded = 1 AND local_path IS NOT NULL",
            params![hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };
    let Some((mime_type, relative_path)) = row else {
        return Ok(None);
    };
    let bytes = std::fs::read(data_dir.join(relative_path)).map_err(|e| e.to_string())?;
    Ok(Some((mime_type, bytes)))
}

/// Whether this device holds an image in full.
pub(crate) fn has_attachment(db: &Connection, hash: &str) -> Result<bool, String> {
    let downloaded: Option<i64> = db
        .query_row(
            "SELECT is_fully_downloaded FROM attachments WHERE hash = ?",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(downloaded == Some(1))
}

/// Told to the page when an image arrives, so an open note shows it.
#[derive(Clone, serde::Serialize)]
pub(crate) struct AttachmentDownloadedEvent {
    pub hash: String,
}

fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::{update_document_index, DocumentIndexInput, INDEX_VERSION};

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        crate::setup_database_tables(&db).unwrap();
        db.execute_batch(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
                 VALUES ('d1', 'note', 'One', x'00010203', 1, 1);
             INSERT INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at)
                 VALUES ('h1', 'image/png', 'attachments/h1.png', 1, 1),
                        ('h2', 'image/png', 'attachments/h2.png', 1, 1);",
        )
        .unwrap();
        db
    }

    fn index_with(hashes: &[&str]) -> DocumentIndexInput {
        DocumentIndexInput {
            text: "body".into(),
            attachment_hashes: hashes.iter().map(|s| s.to_string()).collect(),
            // The rest defaulted, so a field added to the index is not a field
            // added to every fixture that does not care about it.
            ..Default::default()
        }
    }

    fn png(extra: &[u8]) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(extra);
        v
    }

    const EMAIL: &[u8] = b"From: Ana <ana@example.com>\r\n\
Subject: Quarterly report\r\n\
Date: Tue, 3 Nov 2026 09:12:00 +0000\r\n\
\r\n\
The numbers are in.\r\n";

    /// A database and a data directory of their own, for the store.
    fn store() -> (parking_lot::Mutex<Connection>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("oyot-attachments-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (parking_lot::Mutex::new(db()), dir)
    }

    #[test]
    fn an_email_is_stored_as_eml() {
        let (db, dir) = store();
        let stored = store_attachment_at(&db, &dir, EMAIL, "message/rfc822").unwrap();

        assert_eq!(stored.mime_type, "message/rfc822");
        assert_eq!(stored.hash, sha256_hex(EMAIL));
        let file = dir.join(format!("attachments/{}.eml", stored.hash));
        assert_eq!(std::fs::read(file).unwrap(), EMAIL);
        assert_eq!(
            export_filename(&stored.hash, &stored.mime_type),
            Some(format!("{}.eml", stored.hash))
        );
    }

    // What a peer, or a script in the webview, could try: a page declared as
    // an email, an email declared as a picture, or a type the store does not
    // take at all.
    #[test]
    fn a_declared_type_the_bytes_disagree_with_is_refused() {
        let (db, dir) = store();
        let page = b"<!doctype html><script>alert(1)</script>";

        assert!(store_attachment_at(&db, &dir, page, "message/rfc822").is_err());
        assert!(store_attachment_at(&db, &dir, EMAIL, "image/png").is_err());
        assert!(store_attachment_at(&db, &dir, &png(b"x"), "message/rfc822").is_err());
        assert!(store_attachment_at(&db, &dir, EMAIL, "text/html").is_err());
        assert!(store_attachment_at(&db, &dir, page, "image/svg+xml").is_err());
        let written = std::fs::read_dir(dir.join("attachments"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(written, 0, "nothing refused is written");
    }

    #[test]
    fn each_type_is_held_to_its_own_cap() {
        let (db, dir) = store();

        // Over the image cap, under the email one.
        let mut big_email = EMAIL.to_vec();
        big_email.resize(MAX_IMAGE_BYTES + 1, b'x');
        assert!(store_attachment_at(&db, &dir, &big_email, "message/rfc822").is_ok());

        let mut big_image = png(b"");
        big_image.resize(MAX_IMAGE_BYTES + 1, 0);
        let refused = store_attachment_at(&db, &dir, &big_image, "image/png").unwrap_err();
        assert!(refused.starts_with("image is"), "{refused}");

        let mut huge_email = EMAIL.to_vec();
        huge_email.resize(attachment_types::MAX_EMAIL_BYTES + 1, b'x');
        let refused = store_attachment_at(&db, &dir, &huge_email, "message/rfc822").unwrap_err();
        assert!(refused.starts_with("email is"), "{refused}");
    }

    #[test]
    fn an_empty_email_is_refused() {
        let (db, dir) = store();
        let refused = store_attachment_at(&db, &dir, b"", "message/rfc822").unwrap_err();
        assert_eq!(refused, "email is empty");
    }

    // A restore names nothing by type: the archive's file name decides
    // nothing, and the bytes are read for what they are.
    #[test]
    fn a_restored_email_is_stored_as_an_email() {
        let (db, dir) = store();
        let stored = store_checked_attachment_at(&db, &dir, EMAIL).unwrap();
        assert_eq!(stored.mime_type, "message/rfc822");

        let page = b"<!doctype html><script>alert(1)</script>";
        assert!(store_checked_attachment_at(&db, &dir, page).is_err());
    }

    #[test]
    fn a_stored_email_is_searchable_and_collected_with_its_words() {
        let (db, dir) = store();
        let stored = store_attachment_at(&db, &dir, EMAIL, "message/rfc822").unwrap();
        let rows = |db: &Connection| -> i64 {
            db.query_row(
                "SELECT COUNT(*) FROM email_search WHERE hash = ?1",
                params![&stored.hash],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(rows(&db.lock()), 1);

        // Stored again, as a second device's copy arrives: still one row.
        store_attachment_at(&db, &dir, EMAIL, "message/rfc822").unwrap();
        assert_eq!(rows(&db.lock()), 1);

        // Held by no note, and no document is left unindexed, so it goes,
        // and its words with it.
        update_document_index(&db.lock(), "d1", "One", &index_with(&[])).unwrap();
        assert!(collect_orphans(&db, &dir).unwrap() >= 1);
        assert_eq!(rows(&db.lock()), 0);
        assert!(!dir
            .join(format!("attachments/{}.eml", stored.hash))
            .exists());
    }

    // The page never loads an email's file, so it is never told where one is.
    #[test]
    fn only_an_image_has_an_address_for_the_page() {
        let (db, dir) = store();
        let email = store_attachment_at(&db, &dir, EMAIL, "message/rfc822").unwrap();
        let image = store_attachment_at(&db, &dir, &png(b"x"), "image/png").unwrap();

        let db = db.lock();
        assert_eq!(local_image_path(&db, &dir, &email.hash).unwrap(), None);
        assert_eq!(
            local_image_path(&db, &dir, &image.hash).unwrap(),
            Some(dir.join(format!("attachments/{}.png", image.hash)))
        );
        assert_eq!(local_image_path(&db, &dir, "nothing").unwrap(), None);
    }

    #[test]
    fn an_attachment_no_document_embeds_is_unreferenced() {
        let db = db();
        update_document_index(&db, "d1", "One", &index_with(&["h1"])).unwrap();

        let orphans: Vec<String> = unreferenced_attachments(&db)
            .unwrap()
            .into_iter()
            .map(|(h, _)| h)
            .collect();
        assert_eq!(orphans, vec!["h2"], "h1 is still on the page");
    }

    // The case the old implementation could not see at all: the image is
    // removed from the note, so the blob is dead, but it stayed on disk and
    // kept being advertised to peers forever.
    #[test]
    fn removing_an_image_from_a_note_makes_its_blob_collectable() {
        let db = db();
        update_document_index(&db, "d1", "One", &index_with(&["h1", "h2"])).unwrap();
        assert!(unreferenced_attachments(&db).unwrap().is_empty());

        update_document_index(&db, "d1", "One", &index_with(&["h1"])).unwrap();

        let orphans: Vec<String> = unreferenced_attachments(&db)
            .unwrap()
            .into_iter()
            .map(|(h, _)| h)
            .collect();
        assert_eq!(orphans, vec!["h2"]);
    }

    #[test]
    fn a_deleted_documents_attachments_are_collectable() {
        let db = db();
        update_document_index(&db, "d1", "One", &index_with(&["h1", "h2"])).unwrap();
        crate::commands::documents::tombstone_document(&db, "d1", 900).unwrap();

        assert_eq!(unreferenced_attachments(&db).unwrap().len(), 2);
    }

    // Collection has to wait for these: their images are on the page but not
    // in the reference table, so they would all look unreferenced.
    #[test]
    fn a_document_that_has_never_been_indexed_blocks_collection() {
        let db = db();
        assert_eq!(unindexed_document_ids(&db).unwrap(), vec!["d1"]);

        update_document_index(&db, "d1", "One", &index_with(&["h1"])).unwrap();
        assert!(unindexed_document_ids(&db).unwrap().is_empty());
    }

    #[test]
    fn an_empty_document_needs_no_index() {
        let db = db();
        db.execute(
            "INSERT INTO documents (id, type, title, created_at, updated_at)
                 VALUES ('blank', 'note', 'Blank', 1, 1)",
            [],
        )
        .unwrap();
        update_document_index(&db, "d1", "One", &index_with(&[])).unwrap();

        assert!(
            unindexed_document_ids(&db).unwrap().is_empty(),
            "a document with no content has nothing to index"
        );
    }

    #[test]
    fn a_stale_index_version_counts_as_unindexed() {
        let db = db();
        update_document_index(&db, "d1", "One", &index_with(&["h1"])).unwrap();
        db.execute(
            "UPDATE documents SET index_version = ?1 WHERE id = 'd1'",
            params![INDEX_VERSION - 1],
        )
        .unwrap();

        assert_eq!(unindexed_document_ids(&db).unwrap(), vec!["d1"]);
    }
}
