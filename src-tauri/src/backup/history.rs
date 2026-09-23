//! Every backup attempt, and what "last backup" means.
//!
//! One row per attempt, so a failure is as visible as a success, and a row a
//! process left `running` when it died is recognisable as such at the next
//! start (ADR 0026, decision 4).

use super::writer::BackupSummary;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Longest error kept. The message is for a person reading the history, and
/// one that has grown past this has stopped helping them.
const MAX_ERROR_CHARS: usize = 500;

/// What a row says when the process that started it never finished it.
const INTERRUPTED: &str = "the app closed before the backup finished";

/// One attempt, as the settings page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupRecord {
    pub id: i64,
    pub scheduled: bool,
    /// `local`, or a provider's id.
    pub destination: String,
    /// What to call where it went: a file name, or an account.
    pub destination_label: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// `running`, `success`, `failed` or `skipped`.
    pub status: String,
    pub error: Option<String>,
    pub size_bytes: Option<i64>,
    pub document_count: Option<i64>,
    pub attachment_count: Option<i64>,
    pub skipped_attachments: Option<i64>,
    pub skipped_documents: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupStatus {
    /// The newest backup that finished.
    pub last_success: Option<BackupRecord>,
    /// The newest attempt when it is not `last_success`: a failure since then,
    /// or one still running.
    pub latest_attempt: Option<BackupRecord>,
    /// Whether this process is making a backup right now. Filled in by the
    /// command, which is what knows.
    pub running: bool,
}

const COLUMNS: &str = "id, scheduled, destination, destination_label, started_at, finished_at, \
     status, error, size_bytes, document_count, attachment_count, skipped_attachments, \
     skipped_documents";

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<BackupRecord> {
    Ok(BackupRecord {
        id: row.get(0)?,
        scheduled: row.get::<_, i64>(1)? != 0,
        destination: row.get(2)?,
        destination_label: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
        size_bytes: row.get(8)?,
        document_count: row.get(9)?,
        attachment_count: row.get(10)?,
        skipped_attachments: row.get(11)?,
        skipped_documents: row.get(12)?,
    })
}

/// Record that a backup has started. Returns the row to finish later.
pub fn start(
    db: &Connection,
    scheduled: bool,
    destination: &str,
    destination_label: &str,
    started_at: i64,
) -> Result<i64, String> {
    db.execute(
        "INSERT INTO backup_history (scheduled, destination, destination_label, started_at, status)
         VALUES (?1, ?2, ?3, ?4, 'running')",
        params![scheduled, destination, destination_label, started_at],
    )
    .map_err(|e| format!("could not record the backup: {e}"))?;
    Ok(db.last_insert_rowid())
}

/// Record that a backup finished. `location` is where it can be found again,
/// for pruning: kept only where something will ever prune it.
pub fn succeed(
    db: &Connection,
    id: i64,
    finished_at: i64,
    summary: &BackupSummary,
    location: Option<&str>,
) -> Result<(), String> {
    db.execute(
        "UPDATE backup_history
            SET status = 'success', finished_at = ?2, size_bytes = ?3, document_count = ?4,
                attachment_count = ?5, skipped_attachments = ?6, skipped_documents = ?7,
                fingerprint = ?8, location = ?9
          WHERE id = ?1",
        params![
            id,
            finished_at,
            i64::try_from(summary.size_bytes).unwrap_or(i64::MAX),
            summary.document_count as i64,
            summary.attachment_count as i64,
            summary.skipped_attachments as i64,
            summary.skipped_documents.len() as i64,
            summary.fingerprint,
            location,
        ],
    )
    .map_err(|e| format!("could not record the backup: {e}"))?;
    Ok(())
}

pub fn fail(db: &Connection, id: i64, finished_at: i64, error: &str) -> Result<(), String> {
    let error: String = error.chars().take(MAX_ERROR_CHARS).collect();
    db.execute(
        "UPDATE backup_history SET status = 'failed', finished_at = ?2, error = ?3 WHERE id = ?1",
        params![id, finished_at, error],
    )
    .map_err(|e| format!("could not record the failed backup: {e}"))?;
    Ok(())
}

/// Mark every row still `running` as failed. Called at startup, when no
/// backup can be running yet, so any such row belonged to a process that
/// died partway through one.
pub fn mark_interrupted(db: &Connection, now: i64) -> Result<usize, String> {
    db.execute(
        "UPDATE backup_history SET status = 'failed', finished_at = ?1, error = ?2
          WHERE status = 'running'",
        params![now, INTERRUPTED],
    )
    .map_err(|e| format!("could not tidy the backup history: {e}"))
}

pub fn status(db: &Connection) -> Result<BackupStatus, String> {
    let newest = |filter: &str| -> Result<Option<BackupRecord>, String> {
        db.query_row(
            &format!(
                "SELECT {COLUMNS} FROM backup_history {filter}
                  ORDER BY started_at DESC, id DESC LIMIT 1"
            ),
            [],
            row_to_record,
        )
        .optional()
        .map_err(|e| format!("could not read the backup history: {e}"))
    };

    let last_success = newest("WHERE status = 'success'")?;
    let latest = newest("")?;
    let latest_attempt = match (&latest, &last_success) {
        (Some(latest), Some(success)) if latest.id == success.id => None,
        _ => latest,
    };
    Ok(BackupStatus {
        last_success,
        latest_attempt,
        running: false,
    })
}

/// The newest `limit` attempts, newest first.
pub fn recent(db: &Connection, limit: usize) -> Result<Vec<BackupRecord>, String> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM backup_history ORDER BY started_at DESC, id DESC LIMIT ?1"
        ))
        .map_err(|e| format!("could not read the backup history: {e}"))?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = stmt
        .query_map([limit], row_to_record)
        .map_err(|e| format!("could not read the backup history: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read the backup history: {e}"))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::library;
    use super::*;

    fn summary() -> BackupSummary {
        BackupSummary {
            document_count: 12,
            attachment_count: 3,
            skipped_attachments: 1,
            skipped_documents: vec!["Huge".to_string()],
            size_bytes: 4096,
            fingerprint: "f".repeat(64),
        }
    }

    #[test]
    fn nothing_yet_is_nothing() {
        let db = library();
        let status = status(&db).unwrap();
        assert_eq!(status.last_success, None);
        assert_eq!(status.latest_attempt, None);
        assert!(recent(&db, 10).unwrap().is_empty());
    }

    #[test]
    fn a_finished_backup_is_the_last_success() {
        let db = library();
        let id = start(&db, false, "local", "backup.zip", 100).unwrap();
        succeed(&db, id, 150, &summary(), None).unwrap();

        let status = status(&db).unwrap();
        let last = status.last_success.unwrap();
        assert_eq!(last.status, "success");
        assert_eq!(last.destination_label, "backup.zip");
        assert_eq!(last.finished_at, Some(150));
        assert_eq!(last.document_count, Some(12));
        assert_eq!(last.attachment_count, Some(3));
        assert_eq!(last.skipped_attachments, Some(1));
        assert_eq!(last.skipped_documents, Some(1));
        assert_eq!(last.size_bytes, Some(4096));
        // The newest attempt is that same backup, so it is not repeated.
        assert_eq!(status.latest_attempt, None);
    }

    #[test]
    fn a_failure_since_the_last_success_is_reported_beside_it() {
        let db = library();
        let ok = start(&db, false, "local", "first.zip", 100).unwrap();
        succeed(&db, ok, 110, &summary(), None).unwrap();
        let bad = start(&db, false, "local", "second.zip", 200).unwrap();
        fail(&db, bad, 210, "the disk is full").unwrap();

        let status = status(&db).unwrap();
        assert_eq!(status.last_success.unwrap().id, ok);
        let latest = status.latest_attempt.unwrap();
        assert_eq!(latest.id, bad);
        assert_eq!(latest.status, "failed");
        assert_eq!(latest.error.as_deref(), Some("the disk is full"));
    }

    #[test]
    fn keeps_a_long_error_to_a_readable_length() {
        let db = library();
        let id = start(&db, false, "local", "x.zip", 1).unwrap();
        fail(&db, id, 2, &"é".repeat(MAX_ERROR_CHARS * 2)).unwrap();
        let error = recent(&db, 1).unwrap().remove(0).error.unwrap();
        assert_eq!(error.chars().count(), MAX_ERROR_CHARS);
    }

    #[test]
    fn a_backup_left_running_by_a_dead_process_is_marked_failed() {
        let db = library();
        let finished = start(&db, false, "local", "done.zip", 1).unwrap();
        succeed(&db, finished, 2, &summary(), None).unwrap();
        start(&db, false, "local", "cut-short.zip", 3).unwrap();

        assert_eq!(mark_interrupted(&db, 10).unwrap(), 1);
        let rows = recent(&db, 10).unwrap();
        assert_eq!(rows[0].status, "failed");
        assert_eq!(rows[0].error.as_deref(), Some(INTERRUPTED));
        assert_eq!(rows[0].finished_at, Some(10));
        // A finished backup is left as it was.
        assert_eq!(rows[1].status, "success");
    }

    #[test]
    fn lists_the_newest_first_up_to_the_limit() {
        let db = library();
        for at in [10, 30, 20] {
            let id = start(&db, false, "local", &format!("{at}.zip"), at).unwrap();
            succeed(&db, id, at + 1, &summary(), None).unwrap();
        }
        let labels: Vec<String> = recent(&db, 2)
            .unwrap()
            .into_iter()
            .map(|r| r.destination_label)
            .collect();
        assert_eq!(labels, vec!["30.zip", "20.zip"]);
    }
}
