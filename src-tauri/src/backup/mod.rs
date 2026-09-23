//! Backing up the whole library to one file, and reading such a file back.
//!
//! A backup is the CRDT itself, not a rendering of it: every document's Yjs
//! state and the metadata the sync manifest carries, plus the images live
//! notes embed. Reading one back hands out checked documents and images; the
//! merge into the library happens on the sync path, the same way a peer's
//! content arrives.
//!
//! See docs/decisions/0024-back-up-the-crdt-and-import-by-merging.md.

pub mod format;
pub mod history;
pub mod reader;
pub mod snapshot;
pub mod staging;
pub mod writer;

#[cfg(test)]
pub(crate) mod test_support {
    //! A library to back up, and ways to take a backup apart and put it back
    //! together wrong.

    use crate::commands::attachments::sha256_hex;
    use rusqlite::{params, Connection};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

    /// Stands in for this device's signing key, which no backup may contain.
    pub const SECRET: &[u8] = b"signing-key-bytes-that-must-never-leave-the-device";

    pub fn library() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::configure_connection(&db).unwrap();
        crate::setup_database_tables(&db).unwrap();
        db
    }

    /// A scratch directory of our own, so the tests need no dev-dependency.
    pub fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oyot-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A live note titled after its id, holding `state`.
    pub fn add_document(db: &Connection, id: &str, state: &[u8]) {
        db.execute(
            "INSERT INTO documents (id, type, title, crdt_state, created_at, updated_at)
                 VALUES (?1, 'note', ?1, ?2, 1, 1)",
            params![id, state],
        )
        .unwrap();
    }

    pub fn add_identity(db: &Connection, display_name: &str) {
        db.execute(
            "INSERT INTO identity (user_id, node_id, display_name, secret_key)
                 VALUES ('user', 'node', ?1, ?2)",
            params![display_name, SECRET],
        )
        .unwrap();
    }

    /// Bytes the attachment store would take as a PNG.
    pub fn png(extra: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(extra);
        bytes
    }

    /// Store an image under `data_dir` and embed it in `doc_id`, as the
    /// attachment store and the indexer would. Returns its hash.
    pub fn add_attachment(db: &Connection, data_dir: &Path, doc_id: &str, bytes: &[u8]) -> String {
        let hash = sha256_hex(bytes);
        let relative = format!("attachments/{hash}.png");
        std::fs::create_dir_all(data_dir.join("attachments")).unwrap();
        std::fs::write(data_dir.join(&relative), bytes).unwrap();
        db.execute(
            "INSERT INTO attachments (hash, mime_type, local_path, is_fully_downloaded, created_at)
                 VALUES (?1, 'image/png', ?2, 1, 1)",
            params![hash, relative],
        )
        .unwrap();
        db.execute(
            "INSERT INTO document_attachments (document_id, hash) VALUES (?1, ?2)",
            params![doc_id, hash],
        )
        .unwrap();
        hash
    }

    /// Every entry in a zip, in order.
    pub fn entries_of(path: &Path) -> Vec<(String, Vec<u8>)> {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut entry = archive.by_index(i).unwrap();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                (entry.name().to_string(), bytes)
            })
            .collect()
    }

    pub fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(name.as_str(), options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Take a backup apart, change it, and write it back to the same path.
    pub fn rewrite(path: &Path, edit: impl FnOnce(&mut Vec<(String, Vec<u8>)>)) {
        let mut entries = entries_of(path);
        edit(&mut entries);
        write_zip(path, &entries);
    }

    /// Bring the manifest back in line with the entries: refresh the size and
    /// checksum of each, and list any entry it does not know. What a careful
    /// forger would do, so a test can get past the checksums to the check it
    /// is actually about.
    pub fn reseal(entries: &mut [(String, Vec<u8>)]) {
        let index = entries
            .iter()
            .position(|(name, _)| name == "manifest.json")
            .unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(&entries[index].1).unwrap();
        let mut listed = Vec::new();
        for (name, bytes) in entries.iter() {
            if name == "manifest.json" {
                continue;
            }
            listed.push(serde_json::json!({
                "path": name,
                "size": bytes.len(),
                "sha256": sha256_hex(bytes),
            }));
        }
        manifest["entries"] = serde_json::Value::Array(listed);
        entries[index].1 = serde_json::to_vec(&manifest).unwrap();
    }
}
