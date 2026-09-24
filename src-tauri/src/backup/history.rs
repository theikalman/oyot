//! Every backup attempt, and what "last backup" means.
//!
//! One row per attempt, so a failure is as visible as a success, and a row a
//! process left `running` when it died is recognisable as such at the next
//! start (ADR 0026, decision 4).

use super::schedule::{Attempts, Stored};
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

/// A backup about to start, as its history row records it.
#[derive(Debug, Clone)]
pub struct NewAttempt<'a> {
    pub scheduled: bool,
    /// `local` for a file picked in a dialog, `folder` for the scheduled
    /// folder, or a provider's id.
    pub destination: &'a str,
    pub label: &'a str,
    /// The place it goes, when backups there are compared and pruned
    /// together: see `target_for_provider` and `target_for_folder`.
    pub target: Option<&'a str>,
    pub started_at: i64,
}

/// The target of backups to a provider's account. The account is part of it:
/// linking another account is another place, whose backups are never
/// compared with or pruned against the first one's.
pub fn target_for_provider(provider: &str, email: &str) -> String {
    format!("{provider}:{}", email.to_lowercase())
}

pub fn target_for_folder(folder: &std::path::Path) -> String {
    format!("folder:{}", folder.display())
}

/// Record that a backup has started. Returns the row to finish later.
pub fn start(db: &Connection, attempt: &NewAttempt) -> Result<i64, String> {
    db.execute(
        "INSERT INTO backup_history
             (scheduled, destination, destination_label, target, started_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
        params![
            attempt.scheduled,
            attempt.destination,
            attempt.label,
            attempt.target,
            attempt.started_at
        ],
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

/// Record that a scheduled backup found the library as the last backup to
/// the same place left it, and made none.
pub fn skip(db: &Connection, id: i64, finished_at: i64, fingerprint: &str) -> Result<(), String> {
    db.execute(
        "UPDATE backup_history SET status = 'skipped', finished_at = ?2, fingerprint = ?3
          WHERE id = ?1",
        params![id, finished_at, fingerprint],
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
            &format!("SELECT {COLUMNS} FROM backup_history {filter} ORDER BY id DESC LIMIT 1"),
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

/// What timing a schedule needs from the history: when the newest scheduled
/// backup was done, and the failures recorded since.
///
/// "Newest" is the last recorded, not the latest stamped: rows are numbered
/// in the order they are written, which a clock that was wrong at the time
/// cannot reorder.
pub fn scheduled_attempts(db: &Connection) -> Result<Attempts, String> {
    let read = |e: rusqlite::Error| format!("could not read the backup history: {e}");
    let last_done: Option<(i64, i64)> = db
        .query_row(
            "SELECT id, started_at FROM backup_history
              WHERE scheduled = 1 AND status IN ('success', 'skipped')
              ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(read)?;
    // Bounded: hourly retries fill a week with fewer than this, and only
    // the current slot's failures matter to the timing.
    let mut stmt = db
        .prepare(
            "SELECT started_at FROM backup_history
              WHERE scheduled = 1 AND status = 'failed' AND id > ?1
              ORDER BY id DESC LIMIT 500",
        )
        .map_err(read)?;
    let failures = stmt
        .query_map([last_done.map_or(0, |(id, _)| id)], |row| row.get(0))
        .map_err(read)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(read)?;
    Ok(Attempts {
        last_done: last_done.map(|(_, at)| at),
        failures,
    })
}

/// The newest scheduled attempt that failed, for its error.
pub fn last_scheduled_failure(db: &Connection) -> Result<Option<BackupRecord>, String> {
    db.query_row(
        &format!(
            "SELECT {COLUMNS} FROM backup_history
              WHERE scheduled = 1 AND status = 'failed'
              ORDER BY id DESC LIMIT 1"
        ),
        [],
        row_to_record,
    )
    .optional()
    .map_err(|e| format!("could not read the backup history: {e}"))
}

/// The newest backup that reached `target`, whatever started it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastAtTarget {
    pub id: i64,
    /// `None` once the backup is known to be gone.
    pub fingerprint: Option<String>,
    pub location: Option<String>,
    pub size_bytes: Option<i64>,
    /// Whether everything went in: no image or note had to be left out.
    pub complete: bool,
}

pub fn last_success_at(db: &Connection, target: &str) -> Result<Option<LastAtTarget>, String> {
    db.query_row(
        "SELECT id, fingerprint, location, size_bytes,
                COALESCE(skipped_attachments, 0) = 0 AND COALESCE(skipped_documents, 0) = 0
           FROM backup_history
          WHERE target = ?1 AND status = 'success'
          ORDER BY id DESC LIMIT 1",
        [target],
        |row| {
            Ok(LastAtTarget {
                id: row.get(0)?,
                fingerprint: row.get(1)?,
                location: row.get(2)?,
                size_bytes: row.get(3)?,
                complete: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("could not read the backup history: {e}"))
}

/// Every scheduled backup at `target` not known to be gone, newest first.
/// Only ever rows this device wrote, and never a manual backup: these are
/// the only backups pruning may consider.
pub fn scheduled_at(db: &Connection, target: &str) -> Result<Vec<Stored>, String> {
    let read = |e: rusqlite::Error| format!("could not read the backup history: {e}");
    let mut stmt = db
        .prepare(
            "SELECT id, location, COALESCE(document_count, 0),
                    COALESCE(skipped_attachments, 0) = 0 AND COALESCE(skipped_documents, 0) = 0
               FROM backup_history
              WHERE target = ?1 AND scheduled = 1 AND status = 'success'
                AND location IS NOT NULL
              ORDER BY id DESC",
        )
        .map_err(read)?;
    let rows = stmt
        .query_map([target], |row| {
            Ok(Stored {
                id: row.get(0)?,
                location: row.get(1)?,
                document_count: row.get(2)?,
                complete: row.get(3)?,
            })
        })
        .map_err(read)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read)?;
    Ok(rows)
}

/// Record that a backup is gone: pruned, or deleted by the user. It is no
/// longer something to prune, nor something an unchanged library can count
/// as already backed up.
pub fn forget(db: &Connection, id: i64) -> Result<(), String> {
    db.execute(
        "UPDATE backup_history SET location = NULL, fingerprint = NULL WHERE id = ?1",
        [id],
    )
    .map_err(|e| format!("could not update the backup history: {e}"))?;
    Ok(())
}

/// `forget` for whatever row recorded a backup at `location` with a
/// provider, when the user deletes it from the provider's list.
pub fn forget_location(db: &Connection, destination: &str, location: &str) -> Result<(), String> {
    db.execute(
        "UPDATE backup_history SET location = NULL, fingerprint = NULL
          WHERE destination = ?1 AND location = ?2",
        params![destination, location],
    )
    .map_err(|e| format!("could not update the backup history: {e}"))?;
    Ok(())
}

/// The newest `limit` attempts, newest first.
pub fn recent(db: &Connection, limit: usize) -> Result<Vec<BackupRecord>, String> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM backup_history ORDER BY id DESC LIMIT ?1"
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
            device_name: "Desk".to_string(),
        }
    }

    fn manual(label: &str, started_at: i64) -> NewAttempt<'_> {
        NewAttempt {
            scheduled: false,
            destination: "local",
            label,
            target: None,
            started_at,
        }
    }

    fn scheduled(target: &str, started_at: i64) -> NewAttempt<'_> {
        NewAttempt {
            scheduled: true,
            destination: "folder",
            label: "backup.zip",
            target: Some(target),
            started_at,
        }
    }

    fn succeeded(db: &Connection, attempt: &NewAttempt, location: &str) -> i64 {
        let id = start(db, attempt).unwrap();
        succeed(db, id, attempt.started_at + 1, &summary(), Some(location)).unwrap();
        id
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
        let id = start(&db, &manual("backup.zip", 100)).unwrap();
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
        let ok = start(&db, &manual("first.zip", 100)).unwrap();
        succeed(&db, ok, 110, &summary(), None).unwrap();
        let bad = start(&db, &manual("second.zip", 200)).unwrap();
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
        let id = start(&db, &manual("x.zip", 1)).unwrap();
        fail(&db, id, 2, &"é".repeat(MAX_ERROR_CHARS * 2)).unwrap();
        let error = recent(&db, 1).unwrap().remove(0).error.unwrap();
        assert_eq!(error.chars().count(), MAX_ERROR_CHARS);
    }

    #[test]
    fn a_backup_left_running_by_a_dead_process_is_marked_failed() {
        let db = library();
        let finished = start(&db, &manual("done.zip", 1)).unwrap();
        succeed(&db, finished, 2, &summary(), None).unwrap();
        start(&db, &manual("cut-short.zip", 3)).unwrap();

        assert_eq!(mark_interrupted(&db, 10).unwrap(), 1);
        let rows = recent(&db, 10).unwrap();
        assert_eq!(rows[0].status, "failed");
        assert_eq!(rows[0].error.as_deref(), Some(INTERRUPTED));
        assert_eq!(rows[0].finished_at, Some(10));
        // A finished backup is left as it was.
        assert_eq!(rows[1].status, "success");
    }

    #[test]
    fn lists_the_last_recorded_first_up_to_the_limit() {
        let db = library();
        for at in [10, 30, 20] {
            let id = start(&db, &manual(&format!("{at}.zip"), at)).unwrap();
            succeed(&db, id, at + 1, &summary(), None).unwrap();
        }
        let labels: Vec<String> = recent(&db, 2)
            .unwrap()
            .into_iter()
            .map(|r| r.destination_label)
            .collect();
        assert_eq!(labels, vec!["20.zip", "30.zip"]);
    }

    #[test]
    fn a_schedule_hears_of_the_last_done_and_the_failures_since() {
        let db = library();
        assert_eq!(scheduled_attempts(&db).unwrap(), Attempts::default());

        let early = start(&db, &scheduled("t", 10)).unwrap();
        fail(&db, early, 11, "offline").unwrap();
        succeeded(&db, &scheduled("t", 20), "a");
        let skipped = start(&db, &scheduled("t", 30)).unwrap();
        skip(&db, skipped, 31, "f").unwrap();
        for at in [40, 50] {
            let id = start(&db, &scheduled("t", at)).unwrap();
            fail(&db, id, at + 1, "offline").unwrap();
        }
        // A manual failure is nothing to the schedule.
        let manual_failure = start(&db, &manual("m.zip", 60)).unwrap();
        fail(&db, manual_failure, 61, "cancelled").unwrap();

        assert_eq!(
            scheduled_attempts(&db).unwrap(),
            Attempts {
                last_done: Some(30),
                failures: vec![50, 40],
            }
        );
        assert_eq!(last_scheduled_failure(&db).unwrap().unwrap().started_at, 50);
    }

    #[test]
    fn newest_means_last_recorded_whatever_the_clock_said() {
        let db = library();
        // Recorded while the clock was a year ahead, then after it was put
        // right.
        succeeded(&db, &scheduled("t", 1_000_000), "ahead");
        let id = start(&db, &scheduled("t", 10)).unwrap();
        fail(&db, id, 11, "offline").unwrap();
        let later = succeeded(&db, &scheduled("t", 20), "right");

        assert_eq!(scheduled_attempts(&db).unwrap().last_done, Some(20));
        assert_eq!(last_success_at(&db, "t").unwrap().unwrap().id, later);
        assert_eq!(
            scheduled_at(&db, "t")
                .unwrap()
                .iter()
                .map(|s| s.location.as_str())
                .collect::<Vec<_>>(),
            vec!["right", "ahead"]
        );
        assert_eq!(status(&db).unwrap().last_success.unwrap().id, later);
    }

    #[test]
    fn finds_the_newest_backup_at_a_target_whoever_made_it() {
        let db = library();
        succeeded(&db, &scheduled("drive:me@x.com", 10), "old");
        let newest = succeeded(
            &db,
            &NewAttempt {
                scheduled: false,
                ..scheduled("drive:me@x.com", 20)
            },
            "new",
        );
        succeeded(&db, &scheduled("drive:other@x.com", 30), "theirs");

        let last = last_success_at(&db, "drive:me@x.com").unwrap().unwrap();
        assert_eq!(last.id, newest);
        assert_eq!(last.location.as_deref(), Some("new"));
        assert_eq!(last.fingerprint, Some("f".repeat(64)));
        assert_eq!(last.size_bytes, Some(4096));
        // The summary left an image and a note out.
        assert!(!last.complete);

        forget(&db, newest).unwrap();
        let last = last_success_at(&db, "drive:me@x.com").unwrap().unwrap();
        assert_eq!(last.id, newest);
        assert_eq!(last.fingerprint, None);
        assert_eq!(last.location, None);
        assert_eq!(last_success_at(&db, "nowhere").unwrap(), None);
    }

    #[test]
    fn a_backup_with_nothing_left_out_is_complete() {
        let db = library();
        let id = start(&db, &scheduled("t", 1)).unwrap();
        let whole = BackupSummary {
            skipped_attachments: 0,
            skipped_documents: Vec::new(),
            ..summary()
        };
        succeed(&db, id, 2, &whole, Some("a")).unwrap();
        assert!(last_success_at(&db, "t").unwrap().unwrap().complete);
    }

    #[test]
    fn only_scheduled_backups_at_the_same_target_are_ever_pruning_candidates() {
        let db = library();
        let mut ids = Vec::new();
        for at in 1..=3 {
            ids.push(succeeded(&db, &scheduled("t", at * 10), &format!("s{at}")));
        }
        // Never candidates: a manual backup, another target, a failure, and
        // one already removed.
        succeeded(
            &db,
            &NewAttempt {
                scheduled: false,
                ..scheduled("t", 5)
            },
            "manual",
        );
        succeeded(&db, &scheduled("elsewhere", 1), "other");
        let failed = start(&db, &scheduled("t", 2)).unwrap();
        fail(&db, failed, 3, "offline").unwrap();
        let gone = succeeded(&db, &scheduled("t", 3), "gone");
        forget(&db, gone).unwrap();

        assert_eq!(
            scheduled_at(&db, "t").unwrap(),
            vec![
                Stored {
                    id: ids[2],
                    location: "s3".to_string(),
                    document_count: 12,
                    complete: false,
                },
                Stored {
                    id: ids[1],
                    location: "s2".to_string(),
                    document_count: 12,
                    complete: false,
                },
                Stored {
                    id: ids[0],
                    location: "s1".to_string(),
                    document_count: 12,
                    complete: false,
                },
            ]
        );
    }

    #[test]
    fn deleting_a_remote_backup_forgets_its_row() {
        let db = library();
        let id = succeeded(
            &db,
            &NewAttempt {
                destination: "google-drive",
                ..scheduled("google-drive:me@x.com", 10)
            },
            "file-1",
        );
        forget_location(&db, "google-drive", "file-1").unwrap();
        assert!(scheduled_at(&db, "google-drive:me@x.com")
            .unwrap()
            .is_empty());
        let last = last_success_at(&db, "google-drive:me@x.com")
            .unwrap()
            .unwrap();
        assert_eq!((last.id, last.fingerprint), (id, None));
    }

    #[test]
    fn the_account_is_part_of_a_provider_target() {
        assert_eq!(
            target_for_provider("google-drive", "Me@Example.com"),
            target_for_provider("google-drive", "me@example.com")
        );
        assert_ne!(
            target_for_provider("google-drive", "me@example.com"),
            target_for_provider("google-drive", "you@example.com")
        );
    }
}
