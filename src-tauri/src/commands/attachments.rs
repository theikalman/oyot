use crate::db::AppState;
use crate::indexer;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use tauri::Emitter;

/// Largest image we will take in, from disk or from a paste. Mirrors the
/// check the editor does before it calls in, and is the backstop for the peer
/// transfer path, which has no UI in front of it.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// The image types we store, and the extension each is written with.
///
/// Raster only, deliberately. SVG is a script-bearing document, and an
/// attachment arrives from a peer and is rendered in the webview, so accepting
/// it would let a peer run script in the app's origin. Nothing in the editor
/// produces SVG: the picker filters it out and paste/drop yields raster.
fn ext_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// The file an attachment is written as outside the app.
///
/// The same `<hash>.<ext>` it has in the attachment store, and `None` for a
/// stored mime type this build has no extension for. Exposed so the export
/// command and the Markdown links inside the archive are named by one
/// function rather than two that have to agree.
pub fn export_filename(hash: &str, mime_type: &str) -> Option<String> {
    Some(format!("{hash}.{}", ext_for_mime(mime_type)?))
}

fn filename_for(hash: &str, mime_type: &str) -> Result<String, String> {
    let ext =
        ext_for_mime(mime_type).ok_or_else(|| format!("unsupported image type: {mime_type}"))?;
    Ok(format!("{hash}.{ext}"))
}

/// The image type the bytes actually are, by magic number.
///
/// Every declared type in this module arrives from somewhere that could be
/// wrong about it: a filename extension, a webview Blob, or a peer's
/// manifest. The bytes cannot be wrong about themselves. Without this a peer
/// could store arbitrary content as `<hash>.png`; the asset protocol serves
/// by extension and an `<img>` will not execute it, so this is defence in
/// depth, but it costs a dozen lines.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF];

    if bytes.starts_with(PNG) {
        return Some("image/png");
    }
    if bytes.starts_with(JPEG) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // RIFF container, with the form type at offset 8.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

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
fn store_attachment(
    state: &AppState,
    bytes: &[u8],
    mime_type: &str,
) -> Result<StoredImage, String> {
    if bytes.is_empty() {
        return Err("image is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image is {} bytes, over the {} byte limit",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }

    // The bytes decide the type, not the caller. A declared type that
    // disagrees means the caller is wrong or lying, and either way this is
    // not something to store under a name that misdescribes it.
    let detected = sniff_image_mime(bytes)
        .ok_or_else(|| "unsupported image data: only PNG, JPEG, GIF and WebP".to_string())?;
    if ext_for_mime(mime_type) != ext_for_mime(detected) {
        return Err(format!(
            "content is {detected}, which does not match the declared {mime_type}"
        ));
    }
    let mime_type = detected;

    let hash = sha256_hex(bytes);
    let filename = filename_for(&hash, mime_type)?;

    let attachments_dir = state.data_dir.join("attachments");
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    std::fs::write(attachments_dir.join(&filename), bytes).map_err(|e| e.to_string())?;

    let relative_path = format!("attachments/{filename}");
    let now = current_timestamp();

    let db = state.db.lock();
    db.execute(
        "INSERT OR REPLACE INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at) VALUES (?, ?, ?, 1, ?)",
        params![&hash, mime_type, &relative_path, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(StoredImage {
        hash,
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
    })
}

#[derive(serde::Serialize)]
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
    store_attachment(&state, &bytes, declared).map(Some)
}

fn sha256_hex(bytes: &[u8]) -> String {
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
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_data)
        .map_err(|e| e.to_string())?;

    store_attachment(&state, &image_bytes, &mime_type).map(|s| s.hash)
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
    let orphaned = {
        let db = state.db.lock();
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
        let full_path = state.data_dir.join(path);
        if full_path.exists() {
            let _ = std::fs::remove_file(&full_path);
        }
    }

    let db = state.db.lock();
    let mut removed = 0;
    for (hash, _) in &orphaned {
        // The row goes with the file. Leaving it would keep the attachment in
        // our manifest with no bytes behind it.
        removed += db
            .execute("DELETE FROM attachments WHERE hash = ?", params![hash])
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

#[tauri::command]
pub fn get_local_blob_url(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock();
    let result = db.query_row(
        "SELECT local_path FROM attachments WHERE hash = ? AND is_fully_downloaded = 1",
        params![&hash],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(relative_path) => {
            let full_path = state.data_dir.join(relative_path);
            Ok(Some(full_path.to_string_lossy().to_string()))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
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

#[tauri::command]
pub fn list_attachment_manifest(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AttachmentManifestEntry>, String> {
    let rows = {
        let db = state.db.lock();
        referenced_attachments(&db)?
    };

    let mut out = Vec::new();
    for (hash, mime_type, local_path) in rows {
        let size = state
            .data_dir
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

#[derive(serde::Serialize)]
pub struct AttachmentBytesResponse {
    pub hash: String,
    pub mime_type: String,
    pub data: String, // base64
}

// Read one attachment's bytes to answer a peer's `attach-need`.
#[tauri::command]
pub fn get_attachment_bytes(
    state: tauri::State<'_, AppState>,
    hash: String,
) -> Result<Option<AttachmentBytesResponse>, String> {
    use base64::Engine;

    let row: Option<(String, String)> = {
        let db = state.db.lock();
        db.query_row(
            "SELECT mime_type, local_path FROM attachments \
             WHERE hash = ? AND is_fully_downloaded = 1 AND local_path IS NOT NULL",
            params![&hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };

    let Some((mime_type, relative_path)) = row else {
        return Ok(None);
    };

    let full_path = state.data_dir.join(relative_path);
    let bytes = std::fs::read(&full_path).map_err(|e| e.to_string())?;

    Ok(Some(AttachmentBytesResponse {
        hash,
        mime_type,
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

#[derive(Clone, serde::Serialize)]
struct AttachmentDownloadedEvent {
    hash: String,
}

// Persist an attachment pulled from a peer (`attach-data`). The hash is the
// content address, so mismatched bytes are rejected outright. Emits
// `attachment-downloaded` so open editors can re-resolve the image.
#[tauri::command]
pub fn save_attachment_bytes(
    state: tauri::State<'_, AppState>,
    hash: String,
    mime_type: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| e.to_string())?;

    let actual = sha256_hex(&bytes);
    if actual != hash {
        return Err(format!(
            "attachment hash mismatch: expected {hash}, got {actual}"
        ));
    }

    // A peer controls both the bytes and the declared type, and the result is
    // rendered in our webview, so this path gets the same allowlist and cap as
    // a local import rather than trusting the manifest.
    store_attachment(&state, &bytes, &mime_type)?;

    let _ = state
        .app_handle
        .emit("attachment-downloaded", AttachmentDownloadedEvent { hash });
    Ok(())
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

    #[test]
    fn the_bytes_decide_the_image_type() {
        assert_eq!(sniff_image_mime(&png(b"rest")), Some("image/png"));
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"GIF89a....."), Some("image/gif"));

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff_image_mime(&webp), Some("image/webp"));
    }

    // The case this exists for: a peer, or anything rendering in the webview,
    // declaring an image type for content that is not an image at all.
    #[test]
    fn content_that_is_not_an_image_is_refused_whatever_it_claims() {
        assert_eq!(
            sniff_image_mime(b"<svg xmlns=\"...\"><script/></svg>"),
            None
        );
        assert_eq!(sniff_image_mime(b"<!doctype html>"), None);
        assert_eq!(sniff_image_mime(b""), None);
        assert_eq!(sniff_image_mime(b"RIFF1234NOPE"), None);
    }

    #[test]
    fn a_truncated_header_is_not_mistaken_for_an_image() {
        // Shorter than every magic number here, so nothing may index past it.
        assert_eq!(sniff_image_mime(&[0x89, b'P']), None);
        assert_eq!(sniff_image_mime(b"RIFF"), None);
        assert_eq!(sniff_image_mime(b"GIF8"), None);
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
