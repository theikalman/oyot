//! What a backup file is: its entries, what they are called, and how much a
//! reader will accept.
//!
//! This is a file format, not an IPC shape. A backup outlives the build that
//! wrote it, so its types are spelled out here rather than borrowed from the
//! sync manifest or the command structs, which are free to change between
//! releases in ways a file on someone's disk is not.

use crate::commands::attachments::MAX_IMAGE_BYTES;
use serde::{Deserialize, Serialize};

/// What `manifest.json` says the file is.
pub const FORMAT: &str = "oyot-backup";

/// The format this build writes, and the newest it reads.
///
/// Bumped by any change an older reader would get wrong: a new kind of entry,
/// or a field whose meaning changed. An older build then refuses the file and
/// says why, instead of importing the part of it that it understood.
pub const FORMAT_VERSION: u32 = 1;

pub const MANIFEST_ENTRY: &str = "manifest.json";
pub const DOCUMENTS_ENTRY: &str = "documents.json";
pub const PREFERENCES_ENTRY: &str = "preferences.json";

const STATE_PREFIX: &str = "documents/";
const STATE_SUFFIX: &str = ".yjs";
const ATTACHMENT_PREFIX: &str = "attachments/";

/// Longest document id either side will handle. Ours are a UUID or a date;
/// this is room for anything a peer might have minted, and a bound on what
/// an error message will quote.
const MAX_ID_BYTES: usize = 256;

/// How much a backup may hold.
///
/// For the reader these are the defence against an archive built to exhaust
/// memory or time: every entry is read into memory or hashed in full, so each
/// one is capped, and so is the sum. The writer holds itself to the same
/// numbers, so a backup this build made is always one it can read back.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Entries in the archive, `manifest.json` included.
    pub max_entries: usize,
    /// `manifest.json`, `documents.json` and `preferences.json`, each.
    pub max_json_bytes: u64,
    /// One document's Yjs state.
    pub max_state_bytes: u64,
    /// One image. The attachment store refuses anything larger, so a bigger
    /// one could not be imported anyway.
    pub max_attachment_bytes: u64,
    /// Every entry together, uncompressed.
    pub max_total_bytes: u64,
}

impl Limits {
    pub const STANDARD: Limits = Limits {
        max_entries: 250_000,
        max_json_bytes: 64 * 1024 * 1024,
        max_state_bytes: 64 * 1024 * 1024,
        max_attachment_bytes: MAX_IMAGE_BYTES as u64,
        max_total_bytes: 32 * 1024 * 1024 * 1024,
    };
}

/// `manifest.json`: what the file is, where it came from, and a checksum for
/// every other entry in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    /// Always null in format 1. A reader that finds anything else refuses the
    /// file rather than misread it (ADR 0024, decision 6).
    #[serde(default)]
    pub encryption: Option<serde_json::Value>,
    /// The build that wrote it. Informational: `format_version` decides
    /// whether it can be read.
    pub app_version: String,
    /// When the backup was taken, in epoch milliseconds.
    pub created_at: i64,
    pub source_device: SourceDevice,
    /// Live documents, not counting tombstones.
    pub document_count: usize,
    pub attachment_count: usize,
    /// Every entry except the manifest itself.
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDevice {
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    /// Uncompressed.
    pub size: u64,
    /// Lower-case hex SHA-256 of the uncompressed bytes. For a document's
    /// state this is also its content hash, the sync layer's change detector.
    pub sha256: String,
}

/// One row of `documents.json`.
///
/// The same fields the sync manifest carries, with the stamps already
/// resolved to the values this device would advertise to a peer: importing a
/// backup is merging with a peer that happens to be a file (ADR 0024).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDocument {
    pub id: String,
    /// `note` or `journal`.
    pub doc_type: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title_updated_at: i64,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub lifecycle_updated_at: i64,
    /// Pinned to the sidebar, and when that was last set (ADR 0027).
    ///
    /// Both are left out for a document nobody ever pinned, and read as never
    /// pinned when absent. So a library without pins backs up to exactly the
    /// file it did before pins existed, fingerprint included, and a backup
    /// from before then imports with nothing pinned. An older build reading a
    /// newer backup skips both, which costs it the pins and nothing else, so
    /// the format version stays where it is.
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_updated_at: Option<i64>,
    /// The entry holding the document's Yjs state. `None` for a tombstone,
    /// and for a document nobody has typed in.
    pub state: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// `documents.json`. An object rather than a bare list so the file has
/// somewhere to grow.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct DocumentsFile {
    pub documents: Vec<BackupDocument>,
}

/// `preferences.json`: what a user would otherwise have to set again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

/// What an entry's name says it is. Anything else is not part of this format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EntryKind {
    Documents,
    Preferences,
    State,
    /// Named by its content hash, which the reader holds the bytes to.
    Attachment {
        hash: String,
    },
}

impl EntryKind {
    /// Classify an entry name, or `None` for a name this format never writes.
    ///
    /// The shape is checked exactly, and nothing looser is accepted. The
    /// reader never extracts an entry to disk, so a hostile name cannot go
    /// anywhere; this is about refusing an archive that is not what it
    /// claims, not about sanitising paths.
    pub(crate) fn of(path: &str) -> Option<EntryKind> {
        match path {
            DOCUMENTS_ENTRY => return Some(EntryKind::Documents),
            PREFERENCES_ENTRY => return Some(EntryKind::Preferences),
            _ => {}
        }
        if let Some(rest) = path.strip_prefix(STATE_PREFIX) {
            let stem = rest.strip_suffix(STATE_SUFFIX)?;
            let numbered =
                !stem.is_empty() && stem.len() <= 9 && stem.bytes().all(|b| b.is_ascii_digit());
            return numbered.then_some(EntryKind::State);
        }
        if let Some(name) = path.strip_prefix(ATTACHMENT_PREFIX) {
            // The extension is not checked against the image types we store:
            // the attachment store sniffs the type from the bytes on import,
            // so the name decides nothing and a type added later needs no
            // change here.
            let (hash, ext) = name.split_once('.')?;
            let plain_ext = !ext.is_empty()
                && ext.len() <= 8
                && ext
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
            if is_content_hash(hash) && plain_ext {
                return Some(EntryKind::Attachment {
                    hash: hash.to_string(),
                });
            }
        }
        None
    }
}

/// The entry holding the `n`th document state.
///
/// Numbered rather than named after the document, because a journal's id is
/// its date, spaces included, and an entry name should not be something to
/// argue about.
pub(crate) fn state_entry_path(n: usize) -> String {
    format!("{STATE_PREFIX}{n:06}{STATE_SUFFIX}")
}

pub(crate) fn attachment_entry_path(filename: &str) -> String {
    format!("{ATTACHMENT_PREFIX}{filename}")
}

/// A SHA-256 as everything content-addressed in this app spells it: 64
/// lower-case hex characters. Lower case only, so one hash has one name.
pub(crate) fn is_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether a document row is one this format can carry.
///
/// Shared by both ends: the reader refuses a file containing a row that
/// fails, and the writer leaves such a row out and reports it, so the writer
/// cannot produce a backup the reader would refuse.
pub(crate) fn validate_document(doc: &BackupDocument) -> Result<(), String> {
    if doc.id.is_empty() {
        return Err("a document has no id".to_string());
    }
    if doc.id.len() > MAX_ID_BYTES {
        return Err(format!("a document id is {} bytes long", doc.id.len()));
    }
    if doc.id.chars().any(char::is_control) {
        return Err(format!("{:?} is not a document id", doc.id));
    }
    if doc.doc_type != "note" && doc.doc_type != "journal" {
        return Err(format!(
            "{:?} has an unknown document type {:?}",
            doc.id, doc.doc_type
        ));
    }
    // A deleted document's content is dropped with it (ADR 0008), and an
    // import never merges content into a tombstone, so this can only be a
    // file that was edited or built by hand.
    if doc.is_deleted && doc.state.is_some() {
        return Err(format!("{:?} is deleted but carries content", doc.id));
    }
    Ok(())
}

/// The name the save dialog offers: `oyot-backup-2026-09-23-1530.zip`.
///
/// A plain `.zip` rather than an extension of our own, because the Android
/// and iOS pickers filter by type and a custom extension is one more way for a
/// backup to become unselectable.
pub fn suggested_filename<Tz>(at: &chrono::DateTime<Tz>) -> String
where
    Tz: chrono::TimeZone,
    Tz::Offset: std::fmt::Display,
{
    format!("oyot-backup-{}.zip", at.format("%Y-%m-%d-%H%M"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> BackupDocument {
        BackupDocument {
            id: "4c1f0b1e-7f37-4d3c-9a54-0e7f9d0c2b11".to_string(),
            doc_type: "note".to_string(),
            title: "Groceries".to_string(),
            created_at: 1,
            updated_at: 2,
            title_updated_at: 2,
            is_deleted: false,
            deleted_at: None,
            lifecycle_updated_at: 1,
            pinned: false,
            pinned_updated_at: None,
            state: Some(state_entry_path(0)),
        }
    }

    // What documents.json held before pins existed. It has to import as a
    // backup in which nothing is pinned, not fail to parse.
    #[test]
    fn a_row_from_before_pins_reads_as_never_pinned() {
        let row: BackupDocument = serde_json::from_str(
            r#"{"id":"n1","docType":"note","title":"Groceries","createdAt":1,
                "updatedAt":2,"titleUpdatedAt":2,"isDeleted":false,"deletedAt":null,
                "lifecycleUpdatedAt":1,"state":"documents/000000.yjs"}"#,
        )
        .unwrap();
        assert!(!row.pinned);
        assert_eq!(row.pinned_updated_at, None);
    }

    // So a library that never pinned anything backs up to the same bytes, and
    // the same fingerprint, as it did before pins existed.
    #[test]
    fn a_row_never_pinned_is_written_as_it_always_was() {
        let json = serde_json::to_string(&document()).unwrap();
        assert!(!json.contains("pinned"), "got {json}");
    }

    // Unpinning is stamped, and the stamp is what stops an older pin winning,
    // so it is written even though the flag it goes with is not.
    #[test]
    fn a_pin_and_an_unpin_both_survive_the_round_trip() {
        for (pinned, stamp) in [(true, Some(5)), (false, Some(9))] {
            let row = BackupDocument {
                pinned,
                pinned_updated_at: stamp,
                ..document()
            };
            let back: BackupDocument =
                serde_json::from_str(&serde_json::to_string(&row).unwrap()).unwrap();
            assert_eq!(back, row);
        }
    }

    #[test]
    fn names_the_entries_it_writes() {
        assert_eq!(EntryKind::of("documents.json"), Some(EntryKind::Documents));
        assert_eq!(
            EntryKind::of("preferences.json"),
            Some(EntryKind::Preferences)
        );
        assert_eq!(EntryKind::of(&state_entry_path(0)), Some(EntryKind::State));
        assert_eq!(
            EntryKind::of(&state_entry_path(1_234_567)),
            Some(EntryKind::State)
        );

        let hash = "a".repeat(64);
        assert_eq!(
            EntryKind::of(&attachment_entry_path(&format!("{hash}.png"))),
            Some(EntryKind::Attachment { hash })
        );
    }

    #[test]
    fn refuses_every_other_name() {
        let hash = "a".repeat(64);
        for path in [
            "manifest.json", // never listed as an entry of itself
            "notes/groceries.md",
            "../documents.json",
            "documents.json/",
            "documents/000001.json",
            "documents/abc.yjs",
            "documents/.yjs",
            "documents/1234567890.yjs",
            "documents/sub/000001.yjs",
            "attachments/abc.png",
            &format!("attachments/{}.png", "A".repeat(64)),
            &format!("attachments/{hash}"),
            &format!("attachments/{hash}."),
            &format!("attachments/{hash}.tar.gz"),
            &format!("attachments/{hash}.PNG"),
            &format!("attachments/../{hash}.png"),
            &format!("attachments/{hash}.png/../../x"),
        ] {
            assert_eq!(EntryKind::of(path), None, "{path:?} should be refused");
        }
    }

    #[test]
    fn accepts_the_ids_this_app_mints() {
        assert!(validate_document(&document()).is_ok());
        // A journal's id is its date, spaces and all.
        let journal = BackupDocument {
            id: "23 Sep 2026".to_string(),
            doc_type: "journal".to_string(),
            ..document()
        };
        assert!(validate_document(&journal).is_ok());
    }

    #[test]
    fn refuses_a_row_no_device_could_have_written() {
        let cases = [
            BackupDocument {
                id: String::new(),
                ..document()
            },
            BackupDocument {
                id: "x".repeat(MAX_ID_BYTES + 1),
                ..document()
            },
            BackupDocument {
                id: "line\nbreak".to_string(),
                ..document()
            },
            BackupDocument {
                doc_type: "folder".to_string(),
                ..document()
            },
            BackupDocument {
                is_deleted: true,
                deleted_at: Some(3),
                ..document()
            },
        ];
        for doc in cases {
            assert!(
                validate_document(&doc).is_err(),
                "{doc:?} should be refused"
            );
        }
    }

    #[test]
    fn a_tombstone_without_content_is_fine() {
        let tombstone = BackupDocument {
            is_deleted: true,
            deleted_at: Some(3),
            state: None,
            ..document()
        };
        assert!(validate_document(&tombstone).is_ok());
    }

    #[test]
    fn suggests_a_dated_filename() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-09-23T15:30:59+07:00").unwrap();
        assert_eq!(suggested_filename(&at), "oyot-backup-2026-09-23-1530.zip");
    }

    // The encryption field has to exist and be null in every file this build
    // writes, or the promise that a later build can add encryption without
    // an older one misreading the result is empty.
    #[test]
    fn writes_encryption_as_an_explicit_null() {
        let manifest = Manifest {
            format: FORMAT.to_string(),
            format_version: FORMAT_VERSION,
            encryption: None,
            app_version: "0.0.0".to_string(),
            created_at: 0,
            source_device: SourceDevice {
                display_name: "Desk".to_string(),
            },
            document_count: 0,
            attachment_count: 0,
            entries: vec![],
        };
        let json: serde_json::Value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["encryption"], serde_json::Value::Null);
        assert_eq!(json["formatVersion"], 1);
    }
}
