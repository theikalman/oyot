//! Reading a backup back, from a file that has to be treated as hostile.
//!
//! The user picks the file, but it may have been downloaded, edited or built
//! by hand, and what is read here is merged into the library. So the whole
//! archive is checked before anything is handed out: it is this format, a
//! version this build understands, within the size limits, and every entry
//! matches the checksum the manifest gives it (ADR 0024, decision 5).
//!
//! Entries are only ever read into memory by name. Nothing is extracted, so a
//! hostile entry name has nowhere to go.

use super::format::{
    is_content_hash, validate_document, BackupDocument, DocumentsFile, EntryKind, Limits, Manifest,
    ManifestEntry, Preferences, DOCUMENTS_ENTRY, FORMAT, FORMAT_VERSION, MANIFEST_ENTRY,
    PREFERENCES_ENTRY,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use zip::ZipArchive;

/// An opened, fully checked backup.
pub struct BackupReader {
    archive: ZipArchive<BufReader<File>>,
    manifest: Manifest,
    documents: Vec<BackupDocument>,
    preferences: Option<Preferences>,
    /// Every entry the manifest lists, by path.
    entries: HashMap<String, ManifestEntry>,
    /// Every document id, and the entry holding its state if it has one.
    states: HashMap<String, Option<String>>,
    /// Which entry holds each attachment, by hash.
    attachments: HashMap<String, String>,
}

impl BackupReader {
    /// Open a backup and check all of it. Nothing is returned for a file that
    /// fails any check; there is no partial reading of a bad backup.
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_limits(path, Limits::STANDARD)
    }

    pub(crate) fn open_with_limits(path: &Path, limits: Limits) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("could not open the backup: {e}"))?;
        let mut archive = ZipArchive::new(BufReader::new(file))
            .map_err(|_| "this file is not an Oyot backup, or it is damaged".to_string())?;

        if archive.len() > limits.max_entries {
            return Err(format!(
                "this backup has {} entries, more than a backup can hold",
                archive.len()
            ));
        }

        let names: Vec<String> = archive.file_names().map(str::to_string).collect();
        if archive.index_for_name(MANIFEST_ENTRY).is_none() {
            // The Markdown export is the other zip this app writes, and the
            // one a user is most likely to pick by mistake.
            let exported_notes = names
                .iter()
                .any(|n| n.starts_with("notes/") && n.ends_with(".md"));
            return Err(if exported_notes {
                "this is a Markdown export, not a backup. An export can be opened by other apps, \
                 but it cannot be imported back into Oyot."
                    .to_string()
            } else {
                "this file is not an Oyot backup".to_string()
            });
        }

        let manifest_bytes = read_capped(&mut archive, MANIFEST_ENTRY, limits.max_json_bytes)?;
        let manifest = parse_manifest(&manifest_bytes)?;

        // What the manifest lists, checked on its own terms before any entry
        // is read.
        let mut entries: HashMap<String, ManifestEntry> = HashMap::new();
        let mut states_listed: HashSet<String> = HashSet::new();
        let mut attachments: HashMap<String, String> = HashMap::new();
        let mut total: u64 = 0;
        if manifest.entries.len() >= limits.max_entries {
            return Err("this backup lists more entries than a backup can hold".to_string());
        }
        for entry in &manifest.entries {
            let Some(kind) = EntryKind::of(&entry.path) else {
                return Err(damaged(format!(
                    "it lists an unexpected entry {:?}",
                    entry.path
                )));
            };
            if !is_content_hash(&entry.sha256) {
                return Err(damaged(format!("{:?} has no valid checksum", entry.path)));
            }
            let cap = match kind {
                EntryKind::Documents | EntryKind::Preferences => limits.max_json_bytes,
                EntryKind::State => limits.max_state_bytes,
                EntryKind::Attachment { .. } => limits.max_attachment_bytes,
            };
            if entry.size > cap {
                return Err(format!(
                    "{:?} in this backup is {} bytes, more than a backup can hold",
                    entry.path, entry.size
                ));
            }
            total = total.saturating_add(entry.size);
            if total > limits.max_total_bytes {
                return Err("this backup is larger than a backup can be".to_string());
            }
            match kind {
                EntryKind::State => {
                    states_listed.insert(entry.path.clone());
                }
                EntryKind::Attachment { hash } => {
                    // Content-addressed: the name is the hash of the bytes,
                    // and the bytes are held to the manifest's checksum below.
                    if hash != entry.sha256 {
                        return Err(damaged(format!(
                            "{:?} is not named after its contents",
                            entry.path
                        )));
                    }
                    // One image, one entry. Two names for the same bytes is
                    // nothing the writer produces.
                    if attachments.insert(hash, entry.path.clone()).is_some() {
                        return Err(damaged(format!(
                            "{:?} holds an image it already holds",
                            entry.path
                        )));
                    }
                }
                EntryKind::Documents | EntryKind::Preferences => {}
            }
            if entries.insert(entry.path.clone(), entry.clone()).is_some() {
                return Err(damaged(format!("it lists {:?} twice", entry.path)));
            }
        }
        if !entries.contains_key(DOCUMENTS_ENTRY) {
            return Err(damaged("it has no document list".to_string()));
        }

        // The archive holds exactly what the manifest lists. Directory
        // entries carry nothing and are allowed, so a backup some tool has
        // re-packed is not refused over them.
        for name in &names {
            if name == MANIFEST_ENTRY || name.ends_with('/') {
                continue;
            }
            if !entries.contains_key(name) {
                return Err(damaged(format!("it contains an unexpected entry {name:?}")));
            }
        }
        for path in entries.keys() {
            if archive.index_for_name(path).is_none() {
                return Err(damaged(format!("{path:?} is missing")));
            }
        }

        // Every entry against its checksum, streamed so no more than a buffer
        // of it is held at once.
        for entry in &manifest.entries {
            copy_verified(&mut archive, entry, &mut std::io::sink())?;
        }

        let documents_bytes = read_verified(&mut archive, &entries[DOCUMENTS_ENTRY])?;
        let documents: Vec<BackupDocument> =
            serde_json::from_slice::<DocumentsFile>(&documents_bytes)
                .map_err(|e| damaged(format!("its document list cannot be read: {e}")))?
                .documents;

        let mut states: HashMap<String, Option<String>> = HashMap::with_capacity(documents.len());
        for doc in &documents {
            validate_document(doc).map_err(damaged)?;
            if let Some(state) = &doc.state {
                // Listed as a state entry, and claimed by no other document.
                if !states_listed.remove(state) {
                    return Err(damaged(format!(
                        "{:?} refers to {state:?}, which is not a document state it holds",
                        doc.id
                    )));
                }
            }
            if states.insert(doc.id.clone(), doc.state.clone()).is_some() {
                return Err(damaged(format!("{:?} appears twice", doc.id)));
            }
        }
        if let Some(orphan) = states_listed.iter().next() {
            return Err(damaged(format!("{orphan:?} belongs to no document")));
        }

        let live = documents.iter().filter(|d| !d.is_deleted).count();
        if manifest.document_count != live || manifest.attachment_count != attachments.len() {
            return Err(damaged("its counts do not match its contents".to_string()));
        }

        let preferences = match entries.get(PREFERENCES_ENTRY) {
            Some(entry) => {
                let bytes = read_verified(&mut archive, entry)?;
                let mut preferences: Preferences = serde_json::from_slice(&bytes)
                    .map_err(|e| damaged(format!("its preferences cannot be read: {e}")))?;
                // A value this build does not know, perhaps from a newer one,
                // is dropped rather than applied. Preferences are a
                // convenience; none of them is worth refusing a backup over.
                if !matches!(
                    preferences.theme.as_deref(),
                    None | Some("light") | Some("dark")
                ) {
                    preferences.theme = None;
                }
                Some(preferences)
            }
            None => None,
        };

        Ok(BackupReader {
            archive,
            manifest,
            documents,
            preferences,
            entries,
            states,
            attachments,
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Every document row, tombstones included, in the order they were
    /// written.
    pub fn documents(&self) -> &[BackupDocument] {
        &self.documents
    }

    pub fn preferences(&self) -> Option<&Preferences> {
        self.preferences.as_ref()
    }

    /// The SHA-256 of a document's state: the sync layer's content hash, so
    /// comparing it with the local one says whether the backup's copy is any
    /// different, without reading it. `None` for a document with no state.
    pub fn content_hash(&self, doc_id: &str) -> Option<&str> {
        let path = self.states.get(doc_id)?.as_ref()?;
        Some(self.entries.get(path)?.sha256.as_str())
    }

    /// A document's Yjs state, checked against the manifest again as it is
    /// read. `Ok(None)` for a document with no state.
    pub fn read_state(&mut self, doc_id: &str) -> Result<Option<Vec<u8>>, String> {
        let path = self
            .states
            .get(doc_id)
            .ok_or_else(|| format!("this backup has no document {doc_id:?}"))?;
        let Some(path) = path else {
            return Ok(None);
        };
        let entry = self.entries[path].clone();
        read_verified(&mut self.archive, &entry).map(Some)
    }

    /// The hashes of every attachment in the backup.
    pub fn attachment_hashes(&self) -> Vec<String> {
        let mut hashes: Vec<String> = self.attachments.keys().cloned().collect();
        hashes.sort();
        hashes
    }

    /// An attachment's bytes, checked against its hash as they are read.
    pub fn read_attachment(&mut self, hash: &str) -> Result<Vec<u8>, String> {
        let path = self
            .attachments
            .get(hash)
            .ok_or_else(|| format!("this backup has no attachment {hash}"))?;
        let entry = self.entries[path].clone();
        read_verified(&mut self.archive, &entry)
    }
}

/// The first two fields, read on their own. A newer format may have changed
/// everything else, and "made by a newer version" is a much better answer to
/// that than "damaged".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestHeader {
    format: String,
    format_version: u64,
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let header: ManifestHeader = serde_json::from_slice(bytes)
        .map_err(|_| "this file is not an Oyot backup, or it is damaged".to_string())?;
    if header.format != FORMAT {
        return Err("this file is not an Oyot backup".to_string());
    }
    if header.format_version > u64::from(FORMAT_VERSION) {
        return Err(
            "this backup was made by a newer version of Oyot. Update the app to import it."
                .to_string(),
        );
    }
    if header.format_version == 0 {
        return Err(damaged("it has no valid format version".to_string()));
    }

    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|e| damaged(format!("its manifest cannot be read: {e}")))?;
    if manifest.encryption.is_some() {
        return Err(
            "this backup is encrypted, which this version of Oyot cannot read. \
             Update the app to import it."
                .to_string(),
        );
    }
    Ok(manifest)
}

fn damaged(reason: String) -> String {
    format!("this backup is damaged: {reason}")
}

/// Read an entry the manifest does not describe (the manifest itself), up to
/// `cap` bytes.
fn read_capped(
    archive: &mut ZipArchive<BufReader<File>>,
    name: &str,
    cap: u64,
) -> Result<Vec<u8>, String> {
    let file = archive
        .by_name(name)
        .map_err(|e| damaged(format!("{name:?} cannot be read: {e}")))?;
    if file.size() > cap {
        return Err(format!("{name:?} is larger than a backup's can be"));
    }
    let mut bytes = Vec::new();
    // `take` rather than trusting the size the header declared, which is
    // just a number in the file.
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| damaged(format!("{name:?} cannot be read: {e}")))?;
    if bytes.len() as u64 > cap {
        return Err(format!("{name:?} is larger than a backup's can be"));
    }
    Ok(bytes)
}

/// Read a listed entry into memory, held to its checksum.
fn read_verified(
    archive: &mut ZipArchive<BufReader<File>>,
    entry: &ManifestEntry,
) -> Result<Vec<u8>, String> {
    let capacity = usize::try_from(entry.size).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    copy_verified(archive, entry, &mut bytes)?;
    Ok(bytes)
}

/// Copy a listed entry to `out`, failing unless it is exactly the size and
/// the SHA-256 the manifest gives it.
///
/// Reads at most one byte past the declared size, so an entry whose header
/// lies about how large it is costs no more than the manifest said it would.
fn copy_verified<W: Write>(
    archive: &mut ZipArchive<BufReader<File>>,
    entry: &ManifestEntry,
    out: &mut W,
) -> Result<(), String> {
    let path = &entry.path;
    let mut file = archive
        .by_name(path)
        .map_err(|e| damaged(format!("{path:?} cannot be read: {e}")))?;
    if file.size() != entry.size {
        return Err(damaged(format!("{path:?} is not the size it should be")));
    }

    let mut limited = (&mut file).take(entry.size.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut read: u64 = 0;
    loop {
        // The zip reader checks each entry's CRC as it reaches the end, so a
        // corrupted entry usually fails here, before the checksum does.
        let n = limited
            .read(&mut buffer)
            .map_err(|e| damaged(format!("{path:?} cannot be read: {e}")))?;
        if n == 0 {
            break;
        }
        read += n as u64;
        hasher.update(&buffer[..n]);
        out.write_all(&buffer[..n])
            .map_err(|e| format!("could not read {path:?}: {e}"))?;
    }

    if read != entry.size {
        return Err(damaged(format!("{path:?} is not the size it should be")));
    }
    if hex::encode(hasher.finalize()) != entry.sha256 {
        return Err(damaged(format!("{path:?} does not match its checksum")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::format::state_entry_path;
    use super::super::test_support::*;
    use super::super::writer::write_backup;
    use super::*;
    use std::path::PathBuf;

    /// A real backup of a small library: two notes, a tombstone, an image.
    fn backup(dir: &Path) -> PathBuf {
        let db = library();
        add_identity(&db, "Desk");
        add_document(&db, "a", b"first state");
        add_document(&db, "b", b"second state");
        add_document(&db, "c", b"deleted");
        crate::commands::documents::tombstone_document(&db, "c", 10).unwrap();
        add_attachment(&db, dir, "a", &png(b"picture"));

        let path = dir.join("backup.zip");
        write_backup(&db, dir, &Preferences::default(), 1, &path).unwrap();
        path
    }

    fn open_err(path: &Path) -> String {
        match BackupReader::open(path) {
            Ok(_) => panic!("{} should have been refused", path.display()),
            Err(e) => e,
        }
    }

    fn manifest_of(entries: &[(String, Vec<u8>)]) -> serde_json::Value {
        let (_, bytes) = entries.iter().find(|(n, _)| n == MANIFEST_ENTRY).unwrap();
        serde_json::from_slice(bytes).unwrap()
    }

    fn set_manifest(entries: &mut [(String, Vec<u8>)], manifest: &serde_json::Value) {
        let slot = entries
            .iter_mut()
            .find(|(n, _)| n == MANIFEST_ENTRY)
            .unwrap();
        slot.1 = serde_json::to_vec(manifest).unwrap();
    }

    fn edit_documents(
        entries: &mut [(String, Vec<u8>)],
        edit: impl FnOnce(&mut Vec<serde_json::Value>),
    ) {
        let slot = entries
            .iter_mut()
            .find(|(n, _)| n == DOCUMENTS_ENTRY)
            .unwrap();
        let mut file: serde_json::Value = serde_json::from_slice(&slot.1).unwrap();
        edit(file["documents"].as_array_mut().unwrap());
        slot.1 = serde_json::to_vec(&file).unwrap();
        reseal(entries);
    }

    #[test]
    fn opens_what_the_writer_wrote() {
        let dir = scratch();
        let path = backup(&dir);
        let mut reader = BackupReader::open(&path).unwrap();
        assert_eq!(reader.documents().len(), 3);
        assert_eq!(
            reader.read_state("a").unwrap().as_deref(),
            Some(&b"first state"[..])
        );
        assert_eq!(reader.read_state("c").unwrap(), None);
        assert!(reader.read_state("nope").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_file_that_is_not_a_zip() {
        let dir = scratch();
        let path = dir.join("backup.zip");
        std::fs::write(&path, b"definitely not a zip").unwrap();
        assert!(open_err(&path).contains("not an Oyot backup"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_so_when_handed_a_markdown_export() {
        let dir = scratch();
        let path = dir.join("oyot-export.zip");
        write_zip(
            &path,
            &[
                ("notes/groceries.md".to_string(), b"# Groceries".to_vec()),
                ("attachments/x.png".to_string(), png(b"x")),
            ],
        );
        assert!(open_err(&path).contains("Markdown export"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_some_other_zip() {
        let dir = scratch();
        let path = dir.join("photos.zip");
        write_zip(&path, &[("holiday.jpg".to_string(), b"jpeg".to_vec())]);
        assert_eq!(open_err(&path), "this file is not an Oyot backup");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_manifest_for_some_other_format() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let mut manifest = manifest_of(entries);
            manifest["format"] = "something-else".into();
            set_manifest(entries, &manifest);
        });
        assert_eq!(open_err(&path), "this file is not an Oyot backup");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Even when the rest of the manifest has changed shape, which a newer
    // format is free to do: the version is read first, on its own.
    #[test]
    fn asks_for_an_update_for_a_newer_format() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let manifest = serde_json::json!({
                "format": "oyot-backup",
                "formatVersion": 2,
                "somethingNew": true
            });
            set_manifest(entries, &manifest);
        });
        assert!(open_err(&path).contains("newer version of Oyot"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_format_version_zero() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let mut manifest = manifest_of(entries);
            manifest["formatVersion"] = 0.into();
            set_manifest(entries, &manifest);
        });
        assert!(open_err(&path).contains("damaged"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_encrypted_backup_rather_than_misread_it() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let mut manifest = manifest_of(entries);
            manifest["encryption"] = serde_json::json!({ "scheme": "xchacha20poly1305" });
            set_manifest(entries, &manifest);
        });
        assert!(open_err(&path).contains("encrypted"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_entry_that_does_not_match_its_checksum() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let state = state_entry_path(0);
            let slot = entries.iter_mut().find(|(n, _)| *n == state).unwrap();
            slot.1[0] ^= 0xff;
        });
        let error = open_err(&path);
        assert!(error.contains("checksum"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_entry_of_the_wrong_size() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let state = state_entry_path(0);
            let slot = entries.iter_mut().find(|(n, _)| *n == state).unwrap();
            slot.1.push(0);
        });
        let error = open_err(&path);
        assert!(error.contains("size"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_entry_the_manifest_does_not_list() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            entries.push(("notes/sneaky.md".to_string(), b"hello".to_vec()));
        });
        assert!(open_err(&path).contains("unexpected entry"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Nothing is ever extracted, so a traversal name could not escape even if
    // it were accepted. It is refused anyway: it is not a name this format
    // writes, so the file is not what it claims to be.
    #[test]
    fn refuses_a_listed_entry_with_a_name_this_format_never_writes() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            entries.push(("../../.ssh/authorized_keys".to_string(), b"key".to_vec()));
            reseal(entries);
        });
        assert!(open_err(&path).contains("unexpected entry"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_archive_missing_an_entry_it_lists() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            entries.retain(|(n, _)| !n.starts_with("attachments/"));
        });
        assert!(open_err(&path).contains("missing"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_attachment_not_named_after_its_contents() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let slot = entries
                .iter_mut()
                .find(|(n, _)| n.starts_with("attachments/"))
                .unwrap();
            slot.1 = png(b"some other picture");
            reseal(entries);
        });
        assert!(open_err(&path).contains("not named after its contents"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_one_image_under_two_names() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let (name, bytes) = entries
                .iter()
                .find(|(n, _)| n.starts_with("attachments/"))
                .cloned()
                .unwrap();
            entries.push((name.replace(".png", ".jpg"), bytes));
            reseal(entries);
        });
        assert!(open_err(&path).contains("already holds"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_the_same_document_twice() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            edit_documents(entries, |docs| {
                docs[1]["id"] = docs[0]["id"].clone();
            });
        });
        assert!(open_err(&path).contains("appears twice"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_two_documents_sharing_one_state() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            edit_documents(entries, |docs| {
                docs[1]["state"] = docs[0]["state"].clone();
            });
        });
        assert!(open_err(&path).contains("not a document state it holds"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_document_pointing_at_an_image_for_its_state() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let image = entries
                .iter()
                .find(|(n, _)| n.starts_with("attachments/"))
                .map(|(n, _)| n.clone())
                .unwrap();
            edit_documents(entries, |docs| {
                docs[0]["state"] = image.into();
            });
        });
        assert!(open_err(&path).contains("not a document state it holds"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_state_that_belongs_to_no_document() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            edit_documents(entries, |docs| {
                docs[0]["state"] = serde_json::Value::Null;
            });
        });
        assert!(open_err(&path).contains("belongs to no document"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_deleted_document_that_carries_content() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            edit_documents(entries, |docs| {
                docs[0]["isDeleted"] = true.into();
                docs[0]["deletedAt"] = 5.into();
            });
        });
        assert!(open_err(&path).contains("deleted but carries content"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_counts_that_do_not_match_the_contents() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let mut manifest = manifest_of(entries);
            manifest["documentCount"] = 99.into();
            set_manifest(entries, &manifest);
        });
        assert!(open_err(&path).contains("counts"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn drops_a_preference_it_does_not_know_rather_than_refusing() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let slot = entries
                .iter_mut()
                .find(|(n, _)| n == PREFERENCES_ENTRY)
                .unwrap();
            slot.1 = br#"{"theme":"solarized","fontSize":14}"#.to_vec();
            reseal(entries);
        });
        let reader = BackupReader::open(&path).unwrap();
        assert_eq!(reader.preferences(), Some(&Preferences::default()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // The limits are the zip-bomb defence, so each is exercised: a backup
    // that is fine by the standard limits is refused by smaller ones.
    #[test]
    fn holds_a_backup_to_every_limit() {
        let dir = scratch();
        let path = backup(&dir);
        assert!(BackupReader::open_with_limits(&path, Limits::STANDARD).is_ok());

        let cases = [
            Limits {
                max_entries: 3,
                ..Limits::STANDARD
            },
            Limits {
                max_json_bytes: 16,
                ..Limits::STANDARD
            },
            Limits {
                max_state_bytes: 4,
                ..Limits::STANDARD
            },
            Limits {
                max_attachment_bytes: 4,
                ..Limits::STANDARD
            },
            Limits {
                max_total_bytes: 64,
                ..Limits::STANDARD
            },
        ];
        for limits in cases {
            assert!(
                BackupReader::open_with_limits(&path, limits).is_err(),
                "{limits:?} should have refused it"
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // What a zip bomb looks like to this reader: an entry that inflates far
    // past its size in the file. Refused from the manifest's numbers, before
    // a byte of it is inflated.
    #[test]
    fn refuses_an_entry_that_inflates_past_its_limit() {
        let dir = scratch();
        let path = backup(&dir);
        rewrite(&path, |entries| {
            let state = state_entry_path(0);
            let slot = entries.iter_mut().find(|(n, _)| *n == state).unwrap();
            slot.1 = vec![0u8; 8 * 1024 * 1024];
            reseal(entries);
        });
        let compressed = std::fs::metadata(&path).unwrap().len();
        assert!(compressed < 1024 * 1024, "the test needs a small file");

        let limits = Limits {
            max_state_bytes: 1024 * 1024,
            ..Limits::STANDARD
        };
        let error = match BackupReader::open_with_limits(&path, limits) {
            Ok(_) => panic!("should have been refused"),
            Err(e) => e,
        };
        assert!(error.contains("more than a backup can hold"), "{error}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
