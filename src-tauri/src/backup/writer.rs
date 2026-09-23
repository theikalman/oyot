//! Writing a backup.
//!
//! Everything happens here in Rust: unlike the Markdown export, a backup has
//! nothing to render, so no document content crosses IPC on its way into the
//! archive (ADR 0024, decision 3).

use super::format::{
    attachment_entry_path, state_entry_path, validate_document, BackupDocument, DocumentsFile,
    EntryKind, Limits, Manifest, ManifestEntry, Preferences, SourceDevice, DOCUMENTS_ENTRY, FORMAT,
    FORMAT_VERSION, MANIFEST_ENTRY, PREFERENCES_ENTRY,
};
use super::snapshot::{fingerprint, read_snapshot, AttachmentRow};
use crate::commands::attachments::{export_filename, sha256_hex};
use crate::commands::export::zip_time;
use rusqlite::{Connection, OptionalExtension};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// What went into a backup, for the confirmation message and the history.
#[derive(Debug, Clone)]
pub struct BackupSummary {
    /// Live documents. Tombstones are carried too, but are not what anyone
    /// means by "how many notes".
    pub document_count: usize,
    pub attachment_count: usize,
    /// Images a live note embeds whose file could not be included: gone from
    /// disk, damaged, or over the size limit. The export reports the same
    /// thing, for the same reason: the user is the only one who can tell
    /// whether it matters.
    pub skipped_attachments: usize,
    /// Titles of documents whose content could not be included. Not expected
    /// to happen; reported by name if it does, because a backup that is
    /// silently missing a note is the one failure a backup must not have.
    pub skipped_documents: Vec<String>,
    /// The size of the archive on disk.
    pub size_bytes: u64,
    /// See `snapshot::fingerprint`.
    pub fingerprint: String,
}

/// Write a backup of the whole library to `destination`.
///
/// `conn` should be a connection of the backup's own (`open_snapshot`); the
/// whole read happens inside one transaction on it. `data_dir` is what
/// attachment paths in the database are relative to. `created_at` is epoch
/// milliseconds.
///
/// On failure the partial file is removed. A half-written backup that opens
/// and is quietly missing notes is worse than none.
pub fn write_backup(
    conn: &Connection,
    data_dir: &Path,
    preferences: &Preferences,
    created_at: i64,
    destination: &Path,
) -> Result<BackupSummary, String> {
    write_backup_with_limits(
        conn,
        data_dir,
        preferences,
        created_at,
        destination,
        &Limits::STANDARD,
    )
}

pub(crate) fn write_backup_with_limits(
    conn: &Connection,
    data_dir: &Path,
    preferences: &Preferences,
    created_at: i64,
    destination: &Path,
    limits: &Limits,
) -> Result<BackupSummary, String> {
    let result = write_archive(conn, data_dir, preferences, created_at, destination, limits);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

fn write_archive(
    conn: &Connection,
    data_dir: &Path,
    preferences: &Preferences,
    created_at: i64,
    destination: &Path,
    limits: &Limits,
) -> Result<BackupSummary, String> {
    // Read-only work, so the transaction is never committed; dropping it at
    // the end rolls back, which for a reader only releases the snapshot.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start reading the library: {e}"))?;
    let snapshot = read_snapshot(&tx)?;
    let fingerprint = fingerprint(&snapshot, preferences)?;

    let file = File::create(destination)
        .map_err(|e| format!("could not create {}: {e}", destination.display()))?;
    let mut archive = Archive {
        zip: ZipWriter::new(BufWriter::new(file)),
        entries: Vec::new(),
        total: 0,
        limits,
        modified: zip_time(created_at),
    };

    let mut documents: Vec<BackupDocument> = Vec::with_capacity(snapshot.documents.len());
    let mut skipped_documents = Vec::new();
    let mut states = 0usize;
    for row in snapshot.documents {
        let mut doc = row.document;
        if let Err(e) = validate_document(&doc) {
            // Something no reader would accept, so writing it would make the
            // whole backup unreadable. Left out, and named.
            warn_log!("[backup] leaving out a document: {e}");
            skipped_documents.push(display_title(&doc));
            continue;
        }
        if row.has_state {
            let state: Option<Vec<u8>> = tx
                .query_row(
                    "SELECT crdt_state FROM documents WHERE id = ?",
                    [&doc.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("could not read {:?}: {e}", doc.id))?
                .flatten();
            match state {
                Some(state) if state.len() as u64 <= limits.max_state_bytes => {
                    let path = state_entry_path(states);
                    states += 1;
                    archive.add(&path, &state, CompressionMethod::Deflated)?;
                    doc.state = Some(path);
                }
                // Kept as a row without content: the title and the stamps
                // still come back, and the gap is reported rather than hidden.
                Some(state) => {
                    warn_log!(
                        "[backup] {:?} is {} bytes, over the limit; its content is left out",
                        doc.id,
                        state.len()
                    );
                    skipped_documents.push(display_title(&doc));
                }
                // Unreachable within one snapshot: `has_state` came from the
                // same instant. Nothing to write either way.
                None => {}
            }
        }
        documents.push(doc);
    }

    let mut attachment_count = 0usize;
    let mut skipped_attachments = 0usize;
    for attachment in &snapshot.attachments {
        match attachment_bytes(attachment, data_dir, limits) {
            Some((path, bytes)) => {
                // Stored, not deflated: an image is already compressed, and
                // running deflate over it costs time for nothing.
                archive.add(&path, &bytes, CompressionMethod::Stored)?;
                attachment_count += 1;
            }
            None => skipped_attachments += 1,
        }
    }

    let document_count = documents.iter().filter(|d| !d.is_deleted).count();

    let documents_json = serde_json::to_vec(&DocumentsFile { documents })
        .map_err(|e| format!("could not write the document list: {e}"))?;
    if documents_json.len() as u64 > limits.max_json_bytes {
        return Err("the library has too many documents to back up".to_string());
    }
    archive.add(
        DOCUMENTS_ENTRY,
        &documents_json,
        CompressionMethod::Deflated,
    )?;

    let preferences_json = serde_json::to_vec(preferences)
        .map_err(|e| format!("could not write the preferences: {e}"))?;
    archive.add(
        PREFERENCES_ENTRY,
        &preferences_json,
        CompressionMethod::Deflated,
    )?;

    let manifest = Manifest {
        format: FORMAT.to_string(),
        format_version: FORMAT_VERSION,
        encryption: None,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at,
        source_device: SourceDevice {
            display_name: snapshot.device_name.unwrap_or_default(),
        },
        document_count,
        attachment_count,
        entries: std::mem::take(&mut archive.entries),
    };
    let size_bytes = archive.finish(&manifest)?;

    Ok(BackupSummary {
        document_count,
        attachment_count,
        skipped_attachments,
        skipped_documents,
        size_bytes,
        fingerprint,
    })
}

/// An attachment's entry name and bytes, or `None` when it cannot go in.
///
/// Its bytes are hashed against its name before they are written. The reader
/// holds every attachment to that, so a damaged file in the store, written as
/// it is, would make the whole backup unreadable rather than cost one image.
fn attachment_bytes(
    attachment: &AttachmentRow,
    data_dir: &Path,
    limits: &Limits,
) -> Option<(String, Vec<u8>)> {
    let Some(filename) = export_filename(&attachment.hash, &attachment.mime_type) else {
        warn_log!(
            "[backup] skipping {}: no extension for {}",
            attachment.hash,
            attachment.mime_type
        );
        return None;
    };
    let path = attachment_entry_path(&filename);
    if !matches!(EntryKind::of(&path), Some(EntryKind::Attachment { .. })) {
        warn_log!("[backup] skipping {}: not a content hash", attachment.hash);
        return None;
    }

    let source = data_dir.join(&attachment.local_path);
    // Checked before reading, so an oversized file is never loaded only to be
    // turned away.
    match std::fs::metadata(&source) {
        Ok(meta) if meta.len() <= limits.max_attachment_bytes => {}
        Ok(meta) => {
            warn_log!(
                "[backup] skipping {}: {} bytes is over the limit",
                source.display(),
                meta.len()
            );
            return None;
        }
        Err(e) => {
            warn_log!("[backup] skipping {}: {e}", source.display());
            return None;
        }
    }
    let bytes = match std::fs::read(&source) {
        Ok(bytes) => bytes,
        Err(e) => {
            warn_log!("[backup] skipping {}: {e}", source.display());
            return None;
        }
    };
    if bytes.len() as u64 > limits.max_attachment_bytes || sha256_hex(&bytes) != attachment.hash {
        warn_log!(
            "[backup] skipping {}: its contents do not match its hash",
            source.display()
        );
        return None;
    }
    Some((path, bytes))
}

fn display_title(doc: &BackupDocument) -> String {
    if doc.title.trim().is_empty() {
        "Untitled".to_string()
    } else {
        doc.title.clone()
    }
}

/// The archive being written, and the manifest entries for what is in it.
struct Archive<'a> {
    zip: ZipWriter<BufWriter<File>>,
    entries: Vec<ManifestEntry>,
    /// Uncompressed bytes so far.
    total: u64,
    limits: &'a Limits,
    /// Every entry is dated when the backup was taken. `None` for a clock the
    /// zip format cannot represent, which costs the dates and nothing else.
    modified: Option<zip::DateTime>,
}

impl Archive<'_> {
    fn options(&self, method: CompressionMethod) -> SimpleFileOptions {
        let options = SimpleFileOptions::default().compression_method(method);
        match self.modified {
            Some(at) => options.last_modified_time(at),
            None => options,
        }
    }

    fn add(&mut self, path: &str, bytes: &[u8], method: CompressionMethod) -> Result<(), String> {
        // This entry, plus the manifest that is written last.
        if self.entries.len() + 2 > self.limits.max_entries {
            return Err("the library has too many documents and images to back up".to_string());
        }
        self.total = self.total.saturating_add(bytes.len() as u64);
        if self.total > self.limits.max_total_bytes {
            return Err("the library is too large to back up".to_string());
        }

        let options = self.options(method);
        self.zip
            .start_file(path, options)
            .map_err(|e| format!("could not add {path}: {e}"))?;
        self.zip
            .write_all(bytes)
            .map_err(|e| format!("could not write {path}: {e}"))?;
        self.entries.push(ManifestEntry {
            path: path.to_string(),
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        });
        Ok(())
    }

    /// Write the manifest and close the archive. Returns its size on disk.
    fn finish(mut self, manifest: &Manifest) -> Result<u64, String> {
        let json = serde_json::to_vec(manifest)
            .map_err(|e| format!("could not write the manifest: {e}"))?;
        if json.len() as u64 > self.limits.max_json_bytes {
            return Err("the library has too many documents and images to back up".to_string());
        }
        let options = self.options(CompressionMethod::Deflated);
        self.zip
            .start_file(MANIFEST_ENTRY, options)
            .map_err(|e| format!("could not add the manifest: {e}"))?;
        self.zip
            .write_all(&json)
            .map_err(|e| format!("could not write the manifest: {e}"))?;

        // Finishing is what writes the central directory, and the buffer has
        // to be flushed after it: without both, the file exists and nothing
        // will open it. Synced as well, because the point of a backup is
        // surviving the thing that just went wrong.
        let buffered = self
            .zip
            .finish()
            .map_err(|e| format!("could not finish the backup: {e}"))?;
        let file = buffered
            .into_inner()
            .map_err(|e| format!("could not finish writing the backup: {}", e.error()))?;
        file.sync_all()
            .map_err(|e| format!("could not finish writing the backup: {e}"))?;
        file.metadata()
            .map(|m| m.len())
            .map_err(|e| format!("could not read the finished backup: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::reader::BackupReader;
    use super::super::snapshot::library_fingerprint;
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn writes_every_kind_of_document_and_the_images_live_notes_embed() {
        let dir = scratch();
        let db = library();
        add_identity(&db, "Desk");
        add_document(&db, "note-1", b"groceries state");
        add_document(&db, "23 Sep 2026", b"journal state");
        db.execute(
            "UPDATE documents SET type = 'journal' WHERE id = '23 Sep 2026'",
            [],
        )
        .unwrap();
        add_document(&db, "empty", &[0, 0]);
        add_document(&db, "deleted", b"gone");
        let kept = add_attachment(&db, &dir, "note-1", &png(b"kept"));
        let orphaned = add_attachment(&db, &dir, "deleted", &png(b"only on a deleted note"));
        crate::commands::documents::tombstone_document(&db, "deleted", 50).unwrap();

        let destination = dir.join("backup.zip");
        let summary = write_backup(
            &db,
            &dir,
            &Preferences {
                theme: Some("dark".to_string()),
            },
            1_790_000_000_000,
            &destination,
        )
        .unwrap();

        assert_eq!(summary.document_count, 3);
        assert_eq!(summary.attachment_count, 1);
        assert_eq!(summary.skipped_attachments, 0);
        assert!(summary.skipped_documents.is_empty());
        assert_eq!(
            summary.size_bytes,
            std::fs::metadata(&destination).unwrap().len()
        );

        // Read back with the reader, not by poking at the zip: the promise is
        // that whatever this writes, that reads.
        let mut reader = BackupReader::open(&destination).unwrap();
        let manifest = reader.manifest().clone();
        assert_eq!(manifest.format, "oyot-backup");
        assert_eq!(manifest.format_version, 1);
        assert_eq!(manifest.encryption, None);
        assert_eq!(manifest.created_at, 1_790_000_000_000);
        assert_eq!(manifest.source_device.display_name, "Desk");
        assert_eq!(manifest.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(manifest.document_count, 3);
        assert_eq!(manifest.attachment_count, 1);

        let ids: Vec<&str> = reader.documents().iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["23 Sep 2026", "deleted", "empty", "note-1"]);

        assert_eq!(
            reader.read_state("note-1").unwrap().as_deref(),
            Some(&b"groceries state"[..])
        );
        assert_eq!(
            reader.read_state("23 Sep 2026").unwrap().as_deref(),
            Some(&b"journal state"[..])
        );
        assert_eq!(reader.read_state("empty").unwrap(), None);
        assert_eq!(reader.read_state("deleted").unwrap(), None);

        let journal = &reader.documents()[0];
        assert_eq!(journal.doc_type, "journal");
        let deleted = &reader.documents()[1];
        assert!(deleted.is_deleted);
        assert_eq!(deleted.deleted_at, Some(50));
        assert_eq!(deleted.lifecycle_updated_at, 50);

        assert_eq!(reader.attachment_hashes(), vec![kept.clone()]);
        assert_eq!(reader.read_attachment(&kept).unwrap(), png(b"kept"));
        assert!(reader.read_attachment(&orphaned).is_err());

        assert_eq!(
            reader.preferences().and_then(|p| p.theme.as_deref()),
            Some("dark")
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_document_states_hash_is_its_content_hash() {
        let dir = scratch();
        let db = library();
        add_document(&db, "a", b"state bytes");
        let destination = dir.join("backup.zip");
        write_backup(&db, &dir, &Preferences::default(), 0, &destination).unwrap();

        let reader = BackupReader::open(&destination).unwrap();
        let expected = sha256_hex(b"state bytes");
        assert_eq!(reader.content_hash("a"), Some(expected.as_str()));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // The identity row holds this device's signing key. A backup is a file
    // that is going to end up in someone's cloud storage, and a restored
    // device is a new device (ADR 0024, decision 2).
    #[test]
    fn never_carries_the_signing_key_or_the_pairings() {
        let dir = scratch();
        let db = library();
        add_identity(&db, "Desk");
        db.execute(
            "INSERT INTO device_pairs (user_id, peer_node_id, peer_display_name, room_id)
                 VALUES ('u', 'peer-node', 'Phone', 'room-secret')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO device_endpoints (user_id, peer_node_id, host, port, added_at)
                 VALUES ('u', 'peer-node', 'phone.tailnet.example', 19701, 1)",
            [],
        )
        .unwrap();
        add_document(&db, "a", b"state");

        let destination = dir.join("backup.zip");
        write_backup(&db, &dir, &Preferences::default(), 0, &destination).unwrap();

        for (name, bytes) in entries_of(&destination) {
            for needle in [SECRET, b"room-secret", b"peer-node", b"tailnet.example"] {
                assert!(
                    !bytes.windows(needle.len()).any(|w| w == needle),
                    "{name} contains {:?}",
                    String::from_utf8_lossy(needle)
                );
            }
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_out_an_image_it_cannot_vouch_for_and_counts_it() {
        let dir = scratch();
        let db = library();
        add_document(&db, "a", b"state");
        let good = add_attachment(&db, &dir, "a", &png(b"good"));
        let missing = add_attachment(&db, &dir, "a", &png(b"missing"));
        let damaged = add_attachment(&db, &dir, "a", &png(b"damaged"));
        std::fs::remove_file(dir.join(format!("attachments/{missing}.png"))).unwrap();
        std::fs::write(
            dir.join(format!("attachments/{damaged}.png")),
            png(b"not what was hashed"),
        )
        .unwrap();

        let destination = dir.join("backup.zip");
        let summary = write_backup(&db, &dir, &Preferences::default(), 0, &destination).unwrap();
        assert_eq!(summary.attachment_count, 1);
        assert_eq!(summary.skipped_attachments, 2);

        let reader = BackupReader::open(&destination).unwrap();
        assert_eq!(reader.attachment_hashes(), vec![good]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_a_document_too_large_to_carry_as_a_row_and_names_it() {
        let dir = scratch();
        let db = library();
        add_document(&db, "small", b"fits");
        add_document(&db, "large", &[7u8; 64]);
        db.execute("UPDATE documents SET title = 'Huge' WHERE id = 'large'", [])
            .unwrap();
        let limits = Limits {
            max_state_bytes: 16,
            ..Limits::STANDARD
        };

        let destination = dir.join("backup.zip");
        let summary =
            write_backup_with_limits(&db, &dir, &Preferences::default(), 0, &destination, &limits)
                .unwrap();
        assert_eq!(summary.skipped_documents, vec!["Huge".to_string()]);
        assert_eq!(summary.document_count, 2);

        let mut reader = BackupReader::open_with_limits(&destination, limits).unwrap();
        assert_eq!(reader.documents().len(), 2);
        assert_eq!(reader.read_state("large").unwrap(), None);
        assert_eq!(
            reader.read_state("small").unwrap().as_deref(),
            Some(&b"fits"[..])
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_out_a_row_no_reader_would_accept() {
        let dir = scratch();
        let db = library();
        add_document(&db, "fine", b"state");
        add_document(&db, "bad\nid", b"state");

        let destination = dir.join("backup.zip");
        let summary = write_backup(&db, &dir, &Preferences::default(), 0, &destination).unwrap();
        assert_eq!(summary.skipped_documents, vec!["bad\nid".to_string()]);

        let reader = BackupReader::open(&destination).unwrap();
        let ids: Vec<&str> = reader.documents().iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["fine"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removes_the_partial_file_when_it_fails() {
        let dir = scratch();
        let db = library();
        add_document(&db, "a", b"state");
        add_document(&db, "b", b"state");
        let limits = Limits {
            max_total_bytes: 8,
            ..Limits::STANDARD
        };

        let destination = dir.join("backup.zip");
        let error =
            write_backup_with_limits(&db, &dir, &Preferences::default(), 0, &destination, &limits)
                .unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert!(!destination.exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reports_the_same_fingerprint_as_asking_without_a_backup() {
        let dir = scratch();
        let db = library();
        add_document(&db, "a", b"state");
        add_attachment(&db, &dir, "a", &png(b"image"));
        let preferences = Preferences {
            theme: Some("light".to_string()),
        };

        let destination = dir.join("backup.zip");
        let summary = write_backup(&db, &dir, &preferences, 0, &destination).unwrap();
        assert_eq!(
            summary.fingerprint,
            library_fingerprint(&db, &preferences).unwrap()
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backs_up_an_empty_library() {
        let dir = scratch();
        let db = library();
        let destination = dir.join("backup.zip");
        let summary = write_backup(&db, &dir, &Preferences::default(), 0, &destination).unwrap();
        assert_eq!(summary.document_count, 0);

        let reader = BackupReader::open(&destination).unwrap();
        assert!(reader.documents().is_empty());
        assert_eq!(reader.manifest().source_device.display_name, "");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
